import { type FormEvent, useState } from "react";
import { Button, Card, CardBody, CardHeader, Input, Stack } from "@ionnet/iontronic/react";
import FormError from "@/components/FormError/FormError.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, navigate, type RouteMatch } from "@/router/Router.tsx";

/**
 * The panel's challenge lives 5 minutes; a little less here, so the form goes back to the password before the panel
 * would refuse it.
 */
const CHALLENGE_TTL_MS = 4.5 * 60 * 1000;

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
 * `/login?redirect=…`: username and password; on a two-factor challenge a code field replaces the form, with "Use a
 * recovery code" for the case without the phone.
 */
export default function Login(props: Props) {
  const { match } = props;
  const auth = useAuth();
  const redirect = safeRedirect(match.query.get("redirect"));
  const inviteCode = match.query.get("code");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<{ token: string; at: number } | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challenge) {
        if (Date.now() - challenge.at > CHALLENGE_TTL_MS) {
          startOver();
          setError("That took too long. Enter your password again.");
          return;
        }
        await auth.completeTotp(challenge.token, code.trim());
        navigate(redirect);
        return;
      }
      const response = await auth.login({ username: username.trim(), password });
      if (response.twoFactorRequired) {
        setChallenge({ token: response.challengeToken, at: Date.now() });
        setCode("");
        setUseRecovery(false);
      }
      else navigate(redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setChallenge(null);
    setCode("");
    setPassword("");
    setUseRecovery(false);
    setError(null);
  };

  const switchMethod = () => {
    setUseRecovery(!useRecovery);
    setCode("");
    setError(null);
  };

  const description = !challenge
    ? "Use the account an admin created or invited you to."
    : useRecovery
    ? "Enter one of the recovery codes you saved when you turned on two-factor sign-in. Each works once."
    : "Enter the code from your authenticator app.";

  return (
    <Card>
      <CardHeader
        title="Sign in"
        description={description}
      />
      <form onSubmit={submit}>
        <CardBody>
          <Stack gap="16">
            {challenge
              ? (
                <Input
                  key={useRecovery ? "recovery" : "totp"}
                  label={useRecovery ? "Recovery code" : "Code"}
                  placeholder={useRecovery ? "xxxxx-xxxxx" : "123456"}
                  required
                  autoFocus
                  inputMode={useRecovery ? "text" : "numeric"}
                  autoComplete={useRecovery ? "off" : "one-time-code"}
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={useRecovery ? 16 : 7}
                  mono
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              )
              : (
                <>
                  <Input label="Username" required autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
                  <Input label="Password" type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
                </>
              )}
            <FormError>{error}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>{challenge ? "Verify" : "Sign in"}</Button>
            {challenge && (
              <Stack direction="row" gap="8" justify="between" wrap>
                <Button variant="ghost" size="sm" onClick={switchMethod}>{useRecovery ? "Use the app code" : "Use a recovery code"}</Button>
                <Button variant="ghost" size="sm" onClick={startOver}>Back</Button>
              </Stack>
            )}
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
