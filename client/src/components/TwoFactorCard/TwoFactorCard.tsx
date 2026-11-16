import { type FormEvent, useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Dialog, Input, List, ListItem, Spinner, Stack } from "@ionnet/iontronic/react";
import { KeyRound, Mail, ShieldCheck, ShieldOff, Smartphone } from "@ionnet/iontronic/icons";
import type { SecondFactorMethod, TotpStatusResponse } from "@shared/api/auth.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import EmailTwoFactorDialog from "@/components/EmailTwoFactorDialog/EmailTwoFactorDialog.tsx";
import FormError from "@/components/FormError/FormError.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import SecondFactorInput, { type SecondFactorAnswer } from "@/components/SecondFactorInput/SecondFactorInput.tsx";
import TotpSetupDialog, { RecoveryCodes } from "@/components/TotpSetupDialog/TotpSetupDialog.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { useResource } from "@/hooks/useResource.ts";

type ProofMode = "disable-totp" | "disable-email" | "codes";

/**
 * Account page card: the two second factors (authenticator app, `AuthApi.getTotp`; email codes) each with "Turn on" /
 * "Turn off", recovery codes left and "New recovery codes". Turning a method off and making new codes ask for your
 * password and a code from either method (authenticator, emailed, or a recovery code).
 */
export default function TwoFactorCard() {
  const status = useTotpStatus();
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);
  const [emailSetupOpen, setEmailSetupOpen] = useState(false);
  const [proof, setProof] = useState<ProofMode | null>(null);

  if (status.error && !status.data) {
    return <LoadError title="Couldn't load two-factor sign-in" error={status.error} onRetry={status.reload} />;
  }

  const data = status.data;
  const totpOn = data?.enabled ?? false;
  const emailOn = data?.emailEnabled ?? false;
  const anyOn = totpOn || emailOn;
  const left = data?.recoveryCodesLeft ?? 0;

  return (
    <Card>
      <CardHeader
        title="Two-factor sign-in"
        description="Ask for a second code after your password."
        actions={data && (anyOn ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>)}
      />
      <CardBody>
        {!data
          ? <Spinner label="Loading" />
          : (
            <Stack gap="12">
              {!anyOn && <span className="io-text-muted">Anyone with your password can sign in. Turn on a method to also require a code.</span>}
              <List>
                <ListItem
                  icon={Smartphone}
                  title="Authenticator app"
                  badges={totpOn ? <Badge size="sm" tone="ok">On</Badge> : undefined}
                  description="A code from an app on your phone."
                  trailing={totpOn
                    ? <Button size="sm" variant="danger" icon={ShieldOff} onClick={() => setProof("disable-totp")}>Turn off</Button>
                    : <Button size="sm" variant="primary" icon={ShieldCheck} onClick={() => setTotpSetupOpen(true)}>Turn on</Button>}
                />
                <ListItem
                  icon={Mail}
                  title="Email codes"
                  badges={emailOn ? <Badge size="sm" tone="ok">On</Badge> : undefined}
                  description={emailOn || data.emailAvailable ? "A code we email to your confirmed address." : data.emailUnavailableReason ?? "Not available."}
                  trailing={emailOn
                    ? <Button size="sm" variant="danger" icon={ShieldOff} onClick={() => setProof("disable-email")}>Turn off</Button>
                    : <Button size="sm" variant="primary" icon={ShieldCheck} disabled={!data.emailAvailable} onClick={() => setEmailSetupOpen(true)}>Turn on</Button>}
                />
              </List>
              {anyOn && (
                <span className={left <= 2 ? undefined : "io-text-muted"} style={left <= 2 ? { color: "var(--io-color-hue-text-warn)" } : undefined}>
                  {left === 0
                    ? "You have no recovery codes left. Make new ones so you can still sign in without your phone or email."
                    : `${left} recovery code${left === 1 ? "" : "s"} left.${left <= 2 ? " Make new ones soon." : ""}`}
                </span>
              )}
            </Stack>
          )}
      </CardBody>
      {data && anyOn && (
        <CardFooter>
          <Button icon={KeyRound} onClick={() => setProof("codes")}>New recovery codes</Button>
        </CardFooter>
      )}
      <TotpSetupDialog open={totpSetupOpen} onOpenChange={setTotpSetupOpen} onEnabled={() => void status.reload()} />
      <EmailTwoFactorDialog open={emailSetupOpen} onOpenChange={setEmailSetupOpen} onEnabled={() => void status.reload()} />
      <ProofDialog mode={proof} status={data} onClose={() => setProof(null)} onDone={() => void status.reload()} />
    </Card>
  );
}

const PROOF_TEXT: Record<ProofMode, { title: string; description: string; action: string }> = {
  "disable-totp": {
    title: "Turn off the authenticator app",
    description: "Signing in will no longer ask for a code from your app.",
    action: "Turn off",
  },
  "disable-email": {
    title: "Turn off email codes",
    description: "Signing in will no longer ask for a code we email you.",
    action: "Turn off",
  },
  codes: {
    title: "New recovery codes",
    description: "Every old recovery code stops working and ten new ones are shown once.",
    action: "Make new codes",
  },
};

/**
 * Password + a code, for turning a method off or replacing the recovery codes.
 */
function ProofDialog(props: { mode: ProofMode | null; status: TotpStatusResponse | null; onClose: () => void; onDone: () => void }) {
  const { mode, status, onClose, onDone } = props;
  const text = mode ? PROOF_TEXT[mode] : null;
  return (
    <Dialog.Root open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content title={text?.title ?? ""} description={text?.description}>
        {mode && status && <ProofForm mode={mode} status={status} onClose={onClose} onDone={onDone} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ProofForm(props: { mode: ProofMode; status: TotpStatusResponse; onClose: () => void; onDone: () => void }) {
  const { mode, status, onClose, onDone } = props;
  const auth = useAuth();
  const notify = useNotify();
  const [password, setPassword] = useState("");
  const [answer, setAnswer] = useState<SecondFactorAnswer>({ code: "", method: undefined });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const methods: SecondFactorMethod[] = [];
  if (status.enabled) methods.push("totp");
  if (status.emailEnabled) methods.push("email");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || !answer.code) {
      setError("Enter your password and a code.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const body = { password, code: answer.code, method: answer.method };
      if (mode === "disable-totp") {
        await auth.disableTotp(body);
        notify.ok("Authenticator app turned off");
        onDone();
        onClose();
        return;
      }
      if (mode === "disable-email") {
        await auth.disableEmailTwoFactor(body);
        notify.ok("Email codes turned off");
        onDone();
        onClose();
        return;
      }
      setCodes(await auth.regenerateRecoveryCodes(body));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <>
        <Dialog.Body>
          <RecoveryCodes codes={codes} username={auth.user?.username ?? "account"} />
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </Dialog.Footer>
      </>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <Dialog.Body>
        <Stack gap="16">
          <Input label="Password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <SecondFactorInput
            methods={methods}
            emailHint={auth.user?.email ?? null}
            emailState="idle"
            sendEmailCode={async () => (await AuthApi.sendActionEmailCode()).emailHint}
            onChange={setAnswer}
          />
          <FormError>{error}</FormError>
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.Close>Cancel</Dialog.Close>
        <Button type="submit" variant={mode === "codes" ? "primary" : "danger"} loading={busy}>{PROOF_TEXT[mode].action}</Button>
      </Dialog.Footer>
    </form>
  );
}

/**
 * The caller's two-factor state, refetched on `user.updated` for themself (enable, disable, admin reset).
 */
function useTotpStatus() {
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  return useResource(() => AuthApi.getTotp(), [userId], {
    liveEvents: ["user.updated"],
    liveFilter: (_event, data) => !("userId" in data) || data.userId === null || data.userId === userId,
  });
}
