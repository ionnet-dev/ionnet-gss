import { type FormEvent, useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Dialog, Input, Stack } from "@ionnet/iontronic/react";
import { Mail, Pencil } from "@ionnet/iontronic/icons";
import type { SecondFactorMethod } from "@shared/api/auth.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import SecondFactorInput, { type SecondFactorAnswer } from "@/components/SecondFactorInput/SecondFactorInput.tsx";
import FormError from "@/components/FormError/FormError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import { useAuth } from "@/hooks/useAuth.ts";

/**
 * Account page card: your email address and whether it is confirmed, a pending change with "Send the link again" and
 * "Cancel", and the change dialog (needs your password). Without mail on the panel can't confirm anything, so the
 * address is stored as typed.
 */
export default function EmailCard() {
  const auth = useAuth();
  const notify = useNotify();
  const user = auth.user;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<"resend" | "cancel" | null>(null);
  if (!user) return null;

  const mail = auth.isMailEnabled();
  const confirmed = user.email !== null && user.emailVerifiedAt !== null;

  const resend = async () => {
    setBusy("resend");
    try {
      await AuthApi.resendEmailConfirmation();
      notify.ok("Link sent", `Check ${user.pendingEmail ?? user.email} for the confirmation link.`);
    } catch (error) {
      notify.error(error, "Couldn't send the link");
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      await auth.cancelEmailChange();
      notify.ok("Address change cancelled");
    } catch (error) {
      notify.error(error, "Couldn't cancel the change");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Email address"
        description={mail ? "Used for password links, sign-in codes and security notices." : "This panel doesn't send email yet, so the address can't be confirmed."}
        actions={user.email && mail && (confirmed ? <Badge tone="ok">Confirmed</Badge> : <Badge tone="warn">Unconfirmed</Badge>)}
      />
      <CardBody>
        <Stack gap="12">
          {user.email ? <span className="io-mono" data-testid="email-address">{user.email}</span> : <span className="io-text-muted">No email address on this account.</span>}
          {user.email && mail && !confirmed && !user.pendingEmail && (
            <span className="io-text-muted">Open the link we emailed to confirm it. Some sign-in options need a confirmed address.</span>
          )}
          {user.pendingEmail && (
            <Stack gap="8" data-testid="pending-email">
              <span>
                Waiting for you to confirm <span className="io-mono">{user.pendingEmail}</span>. Until then, <span className="io-mono">{user.email ?? "no address"}</span> stays in use.
              </span>
              <Stack direction="row" gap="8" wrap>
                <Button size="sm" onClick={resend} loading={busy === "resend"}>Send the link again</Button>
                <Button size="sm" variant="ghost" onClick={cancel} loading={busy === "cancel"}>Cancel the change</Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </CardBody>
      <CardFooter>
        <Stack direction="row" gap="8" wrap>
          <Button icon={user.email ? Pencil : Mail} variant={user.email ? "secondary" : "primary"} onClick={() => setDialogOpen(true)}>
            {user.email ? "Change address" : "Add address"}
          </Button>
          {user.email && mail && !confirmed && !user.pendingEmail && (
            <Button onClick={resend} loading={busy === "resend"}>Send the link again</Button>
          )}
        </Stack>
      </CardFooter>
      <ChangeEmailDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </Card>
  );
}

function ChangeEmailDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange } = props;
  const auth = useAuth();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        title={auth.user?.email ? "Change email address" : "Add an email address"}
        description={auth.isMailEnabled()
          ? "We'll send a link to the new address. Your current address stays in use until you open it."
          : "This panel doesn't send email, so the new address won't be confirmed."}
      >
        {open && <ChangeEmailForm onClose={() => onOpenChange(false)} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ChangeEmailForm(props: { onClose: () => void }) {
  const { onClose } = props;
  const auth = useAuth();
  const notify = useNotify();
  const current = auth.user?.email ?? null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [answer, setAnswer] = useState<SecondFactorAnswer>({ code: "", method: undefined });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  // Changing the address needs proof of the second factor that is on.
  const methods: SecondFactorMethod[] = [];
  if (auth.user?.totpEnabled) methods.push("totp");
  if (auth.user?.emailTwoFactor) methods.push("email");

  const save = async (next: string | null) => {
    if (next !== null && !next) {
      setError("Enter an email address.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    if (methods.length > 0 && !answer.code) {
      setError("Enter a code from your second factor, or a recovery code.");
      return;
    }
    setError(null);
    setBusy(next === null ? "remove" : "save");
    try {
      const user = await auth.changeEmail(methods.length > 0 ? { email: next, password, code: answer.code, method: answer.method } : { email: next, password });
      if (next === null) notify.ok("Email address removed");
      else if (user.pendingEmail) notify.ok("Check your email", `We sent a confirmation link to ${user.pendingEmail}.`);
      else notify.ok("Email address changed");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save(email.trim());
  };

  return (
    <form onSubmit={submit} noValidate>
      <Dialog.Body>
        <Stack gap="16">
          <Input label="New email address" type="email" autoFocus autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          <Input label="Password" description="Enter your password to confirm it's you." type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          {methods.length > 0 && (
            <SecondFactorInput
              methods={methods}
              emailHint={current}
              emailState="idle"
              sendEmailCode={async () => (await AuthApi.sendActionEmailCode()).emailHint}
              onChange={setAnswer}
            />
          )}
          <FormError>{error}</FormError>
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        {current && <Button variant="danger" onClick={() => void save(null)} loading={busy === "remove"}>Remove address</Button>}
        <Dialog.Close>Cancel</Dialog.Close>
        <Button type="submit" variant="primary" loading={busy === "save"}>{current ? "Change address" : "Add address"}</Button>
      </Dialog.Footer>
    </form>
  );
}
