import { type FormEvent, useState } from "react";
import { Button, Dialog, Input, Stack } from "@ionnet/iontronic/react";
import SecondFactorInput, { type SecondFactorAnswer } from "@/components/SecondFactorInput/SecondFactorInput.tsx";
import FormError from "@/components/FormError/FormError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import { RecoveryCodes } from "@/components/TotpSetupDialog/TotpSetupDialog.tsx";
import { useAuth } from "@/hooks/useAuth.ts";

export interface EmailTwoFactorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Email two-factor is on now.
   */
  onEnabled: () => void;
}

/**
 * Turn on email two-factor with your password, plus a code from the authenticator app (or a recovery code) when that is
 * already on. When it is your first second factor the panel also issues recovery
 * codes, which this dialog shows once.
 */
export default function EmailTwoFactorDialog(props: EmailTwoFactorDialogProps) {
  const { open, onOpenChange, onEnabled } = props;
  const auth = useAuth();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        title="Turn on email codes"
        description={`After your password, signing in will also ask for a code we email to ${auth.user?.email ?? "your address"}.`}
      >
        {open && <EnableForm onEnabled={onEnabled} onClose={() => onOpenChange(false)} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function EnableForm(props: { onEnabled: () => void; onClose: () => void }) {
  const { onEnabled, onClose } = props;
  const auth = useAuth();
  const notify = useNotify();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<SecondFactorAnswer>({ code: "", method: undefined });
  const [codes, setCodes] = useState<string[] | null>(null);
  const needsProof = auth.user?.totpEnabled ?? false;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) {
      setError("Enter your password.");
      return;
    }
    if (needsProof && !answer.code) {
      setError("Enter a code from your authenticator app, or a recovery code.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const recoveryCodes = await auth.enableEmailTwoFactor(needsProof ? { password, code: answer.code, method: answer.method } : { password });
      onEnabled();
      if (recoveryCodes) setCodes(recoveryCodes);
      else {
        notify.ok("Email codes turned on");
        onClose();
      }
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
          <Stack gap="12">
            <span className="io-text-muted">Email codes are on. These recovery codes get you in if you can't reach your email.</span>
            <RecoveryCodes codes={codes} username={auth.user?.username ?? "account"} />
          </Stack>
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
          {needsProof && (
            <SecondFactorInput methods={["totp"]} emailHint={null} emailState="idle" sendEmailCode={async () => null} onChange={setAnswer} />
          )}
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
