import { type FormEvent, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Grid, Input, Select, Separator, Spinner, Stack, Switch } from "@ionnet/iontronic/react";
import { Send } from "@ionnet/iontronic/icons";
import type { MailSecurity, MailSettingsDto, UpdateMailSettingsBody } from "@shared/api/settings.ts";
import { SettingsApi } from "@/Api/SettingsApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import type { RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * The editable copy of `MailSettingsDto`. The stored password never comes to the browser: `password` holds only what
 * was typed, `removePassword` marks the stored one for removal.
 */
interface MailForm {
  enabled: boolean;
  host: string;
  port: string;
  security: MailSecurity;
  username: string;
  password: string;
  removePassword: boolean;
  fromAddress: string;
  fromName: string;
  verifyCertificate: boolean;
  requireConfirmedEmail: boolean;
}

const SECURITY_OPTIONS: { value: MailSecurity; label: string }[] = [
  { value: "starttls", label: "STARTTLS (usually port 587)" },
  { value: "tls", label: "TLS (usually port 465)" },
  { value: "none", label: "None (a relay on your own network)" },
];

function toForm(dto: MailSettingsDto): MailForm {
  return {
    enabled: dto.enabled,
    host: dto.host,
    port: String(dto.port),
    security: dto.security,
    username: dto.username ?? "",
    password: "",
    removePassword: false,
    fromAddress: dto.fromAddress,
    fromName: dto.fromName ?? "",
    verifyCertificate: dto.verifyCertificate,
    requireConfirmedEmail: dto.requireConfirmedEmail,
  };
}

/**
 * The form as an `UpdateMailSettingsBody`: blank optional fields become null, and `password` is left out unless the
 * admin typed one or asked to remove the stored one.
 */
function toBody(form: MailForm): UpdateMailSettingsBody {
  const body: UpdateMailSettingsBody = {
    enabled: form.enabled,
    host: form.host.trim(),
    port: Number(form.port),
    security: form.security,
    username: form.username.trim() || null,
    fromAddress: form.fromAddress.trim(),
    fromName: form.fromName.trim() || null,
    verifyCertificate: form.verifyCertificate,
    requireConfirmedEmail: form.requireConfirmedEmail,
  };
  if (form.password) body.password = form.password;
  else if (form.removePassword) body.password = null;
  return body;
}

/**
 * `/settings` (administrators): the SMTP relay the panel sends email through, with a test send that uses the form's
 * current values before you save. Live: another admin's save refetches it (your unsaved edits stay).
 */
export default function Settings(_props: Props) {
  const mail = SettingsApi.useMail();
  return (
    <Stack gap="16">
      <PageHeader title="Settings" description="How this panel behaves for everyone who uses it." />
      {mail.data === null && mail.loading && <Stack align="center"><Spinner label="Loading settings" /></Stack>}
      {mail.data === null && mail.error && <LoadError title="Couldn't load the settings" error={mail.error} onRetry={mail.reload} />}
      {mail.data && <MailCard dto={mail.data} onSaved={mail.reload} />}
    </Stack>
  );
}

function MailCard(props: { dto: MailSettingsDto; onSaved: () => Promise<void> }) {
  const { dto, onSaved } = props;
  const auth = useAuth();
  const notify = useNotify();
  const [form, setForm] = useState<MailForm>(() => toForm(dto));
  const baseline = useRef<MailForm>(form);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState(auth.user?.email ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // A refetch (another admin saved) replaces the form only while it has no edits of yours.
  useEffect(() => {
    const next = toForm(dto);
    setForm((current) => (JSON.stringify(current) === JSON.stringify(baseline.current) ? next : current));
    baseline.current = next;
  }, [dto]);

  const change = (patch: Partial<MailForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setTestResult(null);
  };

  const dirty = JSON.stringify(form) !== JSON.stringify(baseline.current);

  const portProblem = (): string | null => {
    const port = Number(form.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? null : "Enter a port between 1 and 65535.";
  };

  const problem = (): string | null => {
    const found = portProblem();
    if (found) return found;
    if (form.enabled && !form.host.trim()) return "Enter the SMTP host before turning email on.";
    if (form.enabled && !form.fromAddress.trim()) return "Enter the From address before turning email on.";
    return null;
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const found = problem();
    setError(found);
    if (found) return;
    setBusy(true);
    try {
      const saved = await SettingsApi.updateMail(toBody(form));
      const next = toForm(saved);
      baseline.current = next;
      setForm(next);
      notify.ok("Email settings saved");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    const to = testTo.trim();
    if (!to) {
      setTestResult({ ok: false, text: "Enter an address to send the test to." });
      return;
    }
    const found = portProblem();
    if (found) {
      setTestResult({ ok: false, text: found });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // The server ignores `enabled` for a test, and the form's other values replace the stored ones for this send.
      await SettingsApi.testMail({ to, settings: toBody(form) });
      setTestResult({ ok: true, text: `Sent to ${to}. Check the inbox (and spam).` });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  // The stored password is only sent to the server it was saved for.
  const stored = toForm(dto);
  const serverChanged = form.host.trim() !== stored.host || form.port.trim() !== stored.port || form.security !== stored.security || form.username.trim() !== stored.username;
  const needsPassword = dto.hasPassword && !dto.passwordUnreadable && !form.removePassword && !form.password && serverChanged;
  const hasStored = dto.hasPassword && !form.removePassword;
  const passwordPlaceholder = form.removePassword
    ? "Removed when you save"
    : dto.passwordUnreadable
    ? "Enter the password again"
    : hasStored
    ? "Stored — leave blank to keep"
    : undefined;

  return (
    <Card>
      <CardHeader
        title="Email"
        description="The SMTP server the panel sends password links, confirmations, sign-in codes and security notices through."
        actions={dto.enabled ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>}
      />
      <form onSubmit={save} noValidate>
        <CardBody>
          <Stack gap="16">
            <Switch
              label="Send email"
              description="Off: the panel sends nothing, and password links, email codes and address confirmation are unavailable."
              checked={form.enabled}
              onCheckedChange={(enabled) => change({ enabled, requireConfirmedEmail: enabled && form.requireConfirmedEmail })}
            />
            <Separator />
            <Grid columns={2} minChildWidth="16rem" gap="16" style={{ alignItems: "start" }}>
              <Input label="SMTP host" placeholder="smtp.example.com" autoComplete="off" spellCheck={false} value={form.host} onChange={(event) => change({ host: event.target.value })} />
              <Input label="Port" inputMode="numeric" autoComplete="off" value={form.port} onChange={(event) => change({ port: event.target.value })} />
              <Select<MailSecurity>
                label="Encryption"
                options={SECURITY_OPTIONS}
                value={form.security}
                onValueChange={(security) => security && change({ security })}
              />
              <Input
                label="Username"
                description="Leave blank when the server needs no login."
                autoComplete="off"
                spellCheck={false}
                value={form.username}
                onChange={(event) => change({ username: event.target.value })}
              />
              <Stack gap="8">
                <Input
                  label="Password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={passwordPlaceholder}
                  disabled={form.removePassword}
                  value={form.password}
                  onChange={(event) => change({ password: event.target.value })}
                />
                {needsPassword && (
                  <span role="status" style={{ color: "var(--io-color-hue-text-warn)" }}>
                    Enter the password again. It's only sent to the server it was saved for.
                  </span>
                )}
                {dto.passwordUnreadable && !form.removePassword && (
                  <span role="alert" style={{ color: "var(--io-color-hue-text-warn)" }}>
                    The stored password can't be read any more (the panel's secret changed). Enter it again and save.
                  </span>
                )}
                {dto.hasPassword && (
                  <Stack direction="row" gap="8">
                    {form.removePassword
                      ? <Button size="sm" variant="ghost" onClick={() => change({ removePassword: false })}>Keep the stored password</Button>
                      : <Button size="sm" variant="ghost" onClick={() => change({ removePassword: true, password: "" })}>Remove the stored password</Button>}
                  </Stack>
                )}
              </Stack>
            </Grid>
            <Separator />
            <Grid columns={2} minChildWidth="16rem" gap="16" style={{ alignItems: "start" }}>
              <Input
                label="From address"
                type="email"
                placeholder="gss@example.com"
                autoComplete="off"
                value={form.fromAddress}
                onChange={(event) => change({ fromAddress: event.target.value })}
              />
              <Input
                label="From name"
                description="Optional. Shown to the recipient; the panel's name when blank."
                autoComplete="off"
                value={form.fromName}
                onChange={(event) => change({ fromName: event.target.value })}
              />
            </Grid>
            <Switch
              label="Check the server's certificate"
              description="Turn this off only for a relay with a self-signed certificate."
              checked={form.verifyCertificate}
              onCheckedChange={(verifyCertificate) => change({ verifyCertificate })}
            />
            <Separator />
            <Switch
              label="Require a confirmed email address to sign in"
              description={form.enabled
                ? "Administrators are exempt. Existing users without a confirmed address are asked to confirm it at their next sign-in."
                : "Turn on email first. The panel can't ask for a confirmation it can't send."}
              disabled={!form.enabled}
              checked={form.requireConfirmedEmail}
              onCheckedChange={(requireConfirmedEmail) => change({ requireConfirmedEmail })}
            />
            <Separator />
            <Stack gap="8">
              <Stack direction="row" gap="8" align="end" wrap>
                <Input label="Send a test email to" type="email" autoComplete="off" value={testTo} onChange={(event) => setTestTo(event.target.value)} />
                <Button icon={Send} onClick={sendTest} loading={testing}>Send test email</Button>
              </Stack>
              {testResult
                ? (
                  <span role={testResult.ok ? "status" : "alert"} style={{ color: `var(--io-color-hue-text-${testResult.ok ? "ok" : "bad"})` }}>
                    {testResult.text}
                  </span>
                )
                : <span className="io-text-muted">Sends with the values above, saved or not.</span>}
            </Stack>
            <FormError>{error}</FormError>
          </Stack>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>Save</Button>
        </CardFooter>
      </form>
    </Card>
  );
}
