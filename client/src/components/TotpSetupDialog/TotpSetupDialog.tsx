import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Dialog, Grid, Input, Spinner, Stack } from "@ionnet/iontronic/react";
import { Download } from "@ionnet/iontronic/icons";
import type { TotpSetupBody, TotpSetupResponse } from "@shared/api/auth.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import CopyButton from "@/components/CopyButton/CopyButton.tsx";
import SecondFactorInput, { type SecondFactorAnswer } from "@/components/SecondFactorInput/SecondFactorInput.tsx";
import FormError from "@/components/FormError/FormError.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import QrCode from "@/components/QrCode/QrCode.tsx";
import { useAuth } from "@/hooks/useAuth.ts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
}

/**
 * Two steps: scan (`AuthApi.setupTotp` → `QrCode` of `otpauthUrl` + the secret as text) and confirm a code
 * (`confirmTotp`); then the recovery codes, shown once with copy and download (.txt). While email two-factor is on, a
 * first step asks for the password and an email code (or a recovery code), because adding a factor needs the one already
 * on; the existing recovery codes then stay. M5, parcel C.
 */
export default function TotpSetupDialog(props: Props) {
  const { open, onOpenChange, onEnabled } = props;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        title="Turn on two-factor sign-in"
        description="After your password, signing in will also ask for a code from an authenticator app on your phone."
        size="lg"
      >
        {open && <SetupFlow onEnabled={onEnabled} onClose={() => onOpenChange(false)} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SetupFlow(props: { onEnabled: () => void; onClose: () => void }) {
  const { onEnabled, onClose } = props;
  const auth = useAuth();
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [keptCodes, setKeptCodes] = useState(false);
  const request = useRef<Promise<TotpSetupResponse> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const needsProof = auth.user?.emailTwoFactor ?? false;
  // null while the proof step is still to be answered.
  const [proof, setProof] = useState<TotpSetupBody | null>(needsProof ? null : {});

  // A new secret each time the dialog opens; an unconfirmed one replaces the previous pending setup on the panel.
  // One request per mount (the ref survives StrictMode's second effect run), so the QR shown is the secret stored.
  useEffect(() => {
    if (!proof) return;
    let cancelled = false;
    request.current ??= auth.startTotpSetup(needsProof ? proof : undefined);
    request.current
      .then((response) => !cancelled && setSetup(response))
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err : new Error(String(err))));
    return () => {
      cancelled = true;
    };
  }, [attempt, proof]);

  const retry = () => {
    request.current = null;
    setLoadError(null);
    if (needsProof) setProof(null);
    setAttempt((n) => n + 1);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(value)) {
      setError("Enter the 6-digit code your app shows.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const codes = await auth.confirmTotp(value);
      if (codes) setRecoveryCodes(codes);
      else setKeptCodes(true);
      onEnabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (keptCodes) {
    return (
      <>
        <Dialog.Body>
          <span>Two-factor sign-in with your authenticator app is on. Your recovery codes stay the same.</span>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </Dialog.Footer>
      </>
    );
  }

  if (!proof) return <ProofStep onProof={setProof} />;

  if (recoveryCodes) {
    return (
      <>
        <Dialog.Body>
          <Stack gap="16">
            <span>Two-factor sign-in is on. If you lose your phone, each of these codes signs you in once instead of an app code.</span>
            <RecoveryCodes codes={recoveryCodes} username={auth.user?.username ?? "account"} />
          </Stack>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </Dialog.Footer>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <Dialog.Body>
          <LoadError title="Couldn't start the setup" error={loadError} onRetry={retry} />
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close>Close</Dialog.Close>
        </Dialog.Footer>
      </>
    );
  }

  if (!setup) {
    return (
      <Dialog.Body>
        <Stack align="center">
          <Spinner label="Creating a secret" />
        </Stack>
      </Dialog.Body>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <Dialog.Body>
        <Stack gap="16">
          <span>1. Scan this code with an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password …).</span>
          <Stack direction="row" gap="16" align="center" wrap>
            <QrCode value={setup.otpauthUrl} label="QR code for your authenticator app" />
            <Stack gap="4">
              <span className="io-text-muted">Can't scan it? Enter this key by hand (time-based):</span>
              <Stack direction="row" gap="4" align="center">
                <span className="io-mono" style={{ wordBreak: "break-all" }} data-testid="totp-secret">{groupSecret(setup.secret)}</span>
                <CopyButton text={setup.secret} label="Copy key" />
              </Stack>
            </Stack>
          </Stack>
          <Input
            label="2. Enter the code the app shows"
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            mono
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <FormError>{error}</FormError>
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.Close>Cancel</Dialog.Close>
        <Button type="submit" variant="primary" loading={busy}>Turn on</Button>
      </Dialog.Footer>
    </form>
  );
}

/**
 * Password + an emailed code (or a recovery code): the proof `POST /api/auth/totp/setup` needs while email two-factor
 * is on.
 */
function ProofStep(props: { onProof: (proof: TotpSetupBody) => void }) {
  const { onProof } = props;
  const auth = useAuth();
  const [password, setPassword] = useState("");
  const [answer, setAnswer] = useState<SecondFactorAnswer>({ code: "", method: undefined });
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || !answer.code) {
      setError("Enter your password and a code.");
      return;
    }
    onProof({ password, code: answer.code, method: answer.method });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Dialog.Body>
        <Stack gap="16">
          <span className="io-text-muted">Email codes are on, so confirm it's you first.</span>
          <Input label="Password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <SecondFactorInput
            methods={["email"]}
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
        <Button type="submit" variant="primary">Continue</Button>
      </Dialog.Footer>
    </form>
  );
}

/**
 * Freshly issued recovery codes with copy and download. The panel only stores their hashes, so this is the one
 * time they can be seen.
 */
export function RecoveryCodes(props: { codes: string[]; username: string }) {
  const { codes, username } = props;
  const text = `Ionnet GSS recovery codes for ${username}\nEach code works once.\n\n${codes.join("\n")}\n`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ionnet-gss-recovery-codes-${username}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack gap="8">
      <Grid columns={2} gap="8" data-testid="recovery-codes">
        {codes.map((code) => <span key={code} className="io-mono">{code}</span>)}
      </Grid>
      <Stack direction="row" gap="8" align="center" wrap>
        <Button size="sm" icon={Download} onClick={download}>Download .txt</Button>
        <CopyButton text={codes.join("\n")} label="Copy recovery codes" />
        <span className="io-text-muted">Keep them somewhere safe. They are not shown again.</span>
      </Stack>
    </Stack>
  );
}

/**
 * `ABCD EFGH …` for reading the key off the screen.
 */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
