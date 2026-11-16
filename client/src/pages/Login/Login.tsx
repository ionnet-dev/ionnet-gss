import { type FormEvent, useState } from "react";
import { Button, Card, CardBody, CardHeader, Input, Stack } from "@ionnet/iontronic/react";
import type { EmailConfirmationRequired, TwoFactorChallenge } from "@shared/api/auth.ts";
import AuthStep from "@/components/AuthStep/AuthStep.tsx";
import FormError from "@/components/FormError/FormError.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * Only same-site paths count as a redirect target, so a crafted link can't send you to another origin after sign-in.
 */
function safeRedirect(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

/**
 * `/login?redirect=…`: username and password, then (by the panel's answer) the second-factor step or the "confirm your
 * email address" step. "Forgot password?" shows while the panel sends email.
 */
export default function Login(props: Props) {
  const { match } = props;
  const auth = useAuth();
  const redirect = safeRedirect(match.query.get("redirect"));
  const inviteCode = match.query.get("code");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<TwoFactorChallenge | EmailConfirmationRequired | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await auth.login({ username: username.trim(), password });
      if (response.step === "done") navigate(redirect);
      else setStep(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startOver = (message?: string) => {
    setStep(null);
    setPassword("");
    setError(message ?? null);
  };

  if (step) return <AuthStep response={step} onDone={() => navigate(redirect)} onBack={startOver} />;

  return (
    <Card>
      <CardHeader title="Sign in" description="Use the account an admin created or invited you to." />
      <form onSubmit={submit}>
        <CardBody>
          <Stack gap="16">
            <Input label="Username" required autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
            <Input label="Password" type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            <FormError>{error}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>Sign in</Button>
            {auth.isMailEnabled() && <Link to="/forgot-password">Forgot password?</Link>}
            {inviteCode && (
              <span className="io-text-muted">
                Have an invite? <Link to={`/register?code=${encodeURIComponent(inviteCode)}`}>Create your account</Link>.
              </span>
            )}
          </Stack>
        </CardBody>
      </form>
    </Card>
  );
}
