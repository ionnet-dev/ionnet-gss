import { type FormEvent, useEffect, useState } from "react";
import { Button, Card, CardBody, CardHeader, EmptyState, Input, Spinner, Stack } from "@ionnet/iontronic/react";
import { KeyRound } from "@ionnet/iontronic/icons";
import { passwordProblem } from "@shared/constants.ts";
import type { EmailConfirmationRequired, PasswordLinkPreviewResponse, TwoFactorChallenge } from "@shared/api/auth.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import AuthStep from "@/components/AuthStep/AuthStep.tsx";
import FormError from "@/components/FormError/FormError.tsx";
import { formatUntil } from "@/components/Format/format.ts";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/reset-password?token=…`: opened from a password link. Shows what the link is for before it is used ("Set your
 * password" for a new account, "Choose a new password" after a reset), then sets the password and signs in, or
 * continues into the second-factor step.
 */
export default function ResetPassword(props: Props) {
  const { match } = props;
  const auth = useAuth();
  const token = match.query.get("token");
  const [preview, setPreview] = useState<PasswordLinkPreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setPreview(null);
    setLoadError(null);
    AuthApi.previewPasswordLink(token).then(
      (result) => !cancelled && setPreview(result),
      (error) => !cancelled && setLoadError(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const toLogin = <Link to="/login">Go to sign in</Link>;
  const again = auth.isMailEnabled() ? <Stack direction="row" gap="16" justify="center" wrap><Link to="/forgot-password">Send a new link</Link>{toLogin}</Stack> : toLogin;

  if (!token) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={KeyRound} tone="warn" title="This link is incomplete" description="Open the whole link from your email, or ask for a new one." actions={again} />
        </CardBody>
      </Card>
    );
  }
  if (loadError) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={KeyRound} tone="bad" title="Couldn't check your link" description={loadError} actions={toLogin} />
        </CardBody>
      </Card>
    );
  }
  if (!preview) {
    return (
      <Card>
        <CardBody><Stack align="center"><Spinner label="Checking your link" /></Stack></CardBody>
      </Card>
    );
  }
  if (!preview.valid || !preview.kind) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={KeyRound}
            tone="warn"
            title="This link can't be used"
            description="It has expired or was already used. Ask for a new one."
            actions={again}
          />
        </CardBody>
      </Card>
    );
  }
  return <ResetForm token={token} preview={preview} kind={preview.kind} />;
}

function ResetForm(props: { token: string; preview: PasswordLinkPreviewResponse; kind: "reset" | "welcome" }) {
  const { token, preview, kind } = props;
  const auth = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<TwoFactorChallenge | EmailConfirmationRequired | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    const problem = passwordProblem(password);
    if (problem) found.password = problem;
    if (confirm !== password) found.confirm = "The passwords don't match.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const response = await auth.resetPassword({ token, password });
      if (response.step === "done") navigate("/");
      else {
        setStep(response);
        setBusy(false);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  if (step) return <AuthStep response={step} intro="Your password is set." onDone={() => navigate("/")} onBack={() => navigate("/login")} />;

  const welcome = kind === "welcome";
  const who = preview.username ? ` for ${preview.username}` : "";
  const expires = preview.expiresAt ? ` This link expires ${formatUntil(preview.expiresAt)}.` : "";

  return (
    <Card>
      <CardHeader
        title={welcome ? "Set your password" : "Choose a new password"}
        description={`${welcome ? `Choose a password${who} to finish creating your account.` : `Choose a new password${who}. Your other sessions are signed out.`}${expires}`}
      />
      <form onSubmit={submit} noValidate>
        <CardBody>
          <Stack gap="16">
            <Input label="New password" type="password" required autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} error={errors.password} />
            <Input label="Repeat password" type="password" required autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} error={errors.confirm} />
            <FormError>{formError}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>{welcome ? "Set password" : "Change password"}</Button>
          </Stack>
        </CardBody>
      </form>
    </Card>
  );
}
