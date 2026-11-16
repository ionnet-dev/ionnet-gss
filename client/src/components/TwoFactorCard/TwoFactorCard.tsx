import { type FormEvent, useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Dialog, Input, Spinner, Stack } from "@ionnet/iontronic/react";
import { KeyRound, ShieldCheck, ShieldOff } from "@ionnet/iontronic/icons";
import { AuthApi } from "@/Api/AuthApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import TotpSetupDialog, { RecoveryCodes } from "@/components/TotpSetupDialog/TotpSetupDialog.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { useResource } from "@/hooks/useResource.ts";

type ProofMode = "disable" | "codes";

/**
 * Account page card: two-factor state (`AuthApi.getTotp`), "Turn on" (opens `TotpSetupDialog`), "Turn off" and "New
 * recovery codes" (password + code), recovery codes left. M5, parcel C.
 */
export default function TwoFactorCard() {
  const status = useTotpStatus();
  const [setupOpen, setSetupOpen] = useState(false);
  const [proof, setProof] = useState<ProofMode | null>(null);

  if (status.error && !status.data) {
    return <LoadError title="Couldn't load two-factor sign-in" error={status.error} onRetry={status.reload} />;
  }

  const data = status.data;
  const enabled = data?.enabled ?? false;
  const left = data?.recoveryCodesLeft ?? 0;

  return (
    <Card>
      <CardHeader
        title="Two-factor sign-in"
        description="Ask for a code from an authenticator app after your password."
        actions={data && (enabled ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>)}
      />
      <CardBody>
        {!data
          ? <Spinner label="Loading" />
          : enabled
          ? (
            <span className={left <= 2 ? undefined : "io-text-muted"} style={left <= 2 ? { color: "var(--io-color-hue-text-warn)" } : undefined}>
              {left === 0
                ? "You have no recovery codes left. Make new ones so you can still sign in without your phone."
                : `${left} recovery code${left === 1 ? "" : "s"} left.${left <= 2 ? " Make new ones soon." : ""}`}
            </span>
          )
          : <span className="io-text-muted">Anyone with your password can sign in. Turn this on to also require your phone.</span>}
      </CardBody>
      {data && (
        <CardFooter>
          {enabled
            ? (
              <Stack direction="row" gap="8" wrap>
                <Button icon={KeyRound} onClick={() => setProof("codes")}>New recovery codes</Button>
                <Button variant="danger" icon={ShieldOff} onClick={() => setProof("disable")}>Turn off</Button>
              </Stack>
            )
            : <Button variant="primary" icon={ShieldCheck} onClick={() => setSetupOpen(true)}>Turn on</Button>}
        </CardFooter>
      )}
      <TotpSetupDialog open={setupOpen} onOpenChange={setSetupOpen} onEnabled={() => void status.reload()} />
      <ProofDialog mode={proof} onClose={() => setProof(null)} onDone={() => void status.reload()} />
    </Card>
  );
}

/**
 * Password + current (or recovery) code, for turning two-factor off or replacing the recovery codes.
 */
function ProofDialog(props: { mode: ProofMode | null; onClose: () => void; onDone: () => void }) {
  const { mode, onClose, onDone } = props;
  return (
    <Dialog.Root open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content
        title={mode === "disable" ? "Turn off two-factor sign-in" : "New recovery codes"}
        description={mode === "disable"
          ? "Signing in will only need your password again. Your recovery codes stop working."
          : "Every old recovery code stops working and ten new ones are shown once."}
      >
        {mode && <ProofForm mode={mode} onClose={onClose} onDone={onDone} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ProofForm(props: { mode: ProofMode; onClose: () => void; onDone: () => void }) {
  const { mode, onClose, onDone } = props;
  const auth = useAuth();
  const notify = useNotify();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || !code.trim()) {
      setError("Enter your password and a code.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const body = { password, code: code.trim() };
      if (mode === "disable") {
        await auth.disableTotp(body);
        notify.ok("Two-factor sign-in turned off");
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
          <Input
            label="Code"
            description="The current code from your app, or one recovery code (which is then used up)."
            autoComplete="one-time-code"
            mono
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <FormError>{error}</FormError>
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.Close>Cancel</Dialog.Close>
        <Button type="submit" variant={mode === "disable" ? "danger" : "primary"} loading={busy}>
          {mode === "disable" ? "Turn off" : "Make new codes"}
        </Button>
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
