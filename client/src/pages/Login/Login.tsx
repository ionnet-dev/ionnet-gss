import { type FormEvent, useState } from "react";
import { Button, Card, CardBody, CardHeader, Input, Stack } from "@ionnet/iontronic/react";
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
 * `/login?redirect=…`: username and password; on a two-factor challenge a code field replaces the form.
 */
export default function Login(props: Props) {
  const { match } = props;
  const auth = useAuth();
  const redirect = safeRedirect(match.query.get("redirect"));
  const inviteCode = match.query.get("code");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challenge) {
        await auth.completeTotp(challenge, code.trim());
        navigate(redirect);
        return;
      }
      const response = await auth.login({ username: username.trim(), password });
      if (response.twoFactorRequired) setChallenge(response.challengeToken);
      else navigate(redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Sign in"
        description={challenge ? "Enter the code from your authenticator app." : "Use the account an admin created or invited you to."}
      />
      <form onSubmit={submit}>
        <CardBody>
          <Stack gap="16">
            {challenge
              ? <Input label="Code" required autoFocus inputMode="numeric" autoComplete="one-time-code" mono value={code} onChange={(event) => setCode(event.target.value)} />
              : (
                <>
                  <Input label="Username" required autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
                  <Input label="Password" type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
                </>
              )}
            <FormError>{error}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>{challenge ? "Verify" : "Sign in"}</Button>
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
