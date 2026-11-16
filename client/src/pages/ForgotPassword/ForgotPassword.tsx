import { type FormEvent, useState } from "react";
import { Button, Card, CardBody, CardHeader, EmptyState, Input, Stack } from "@ionnet/iontronic/react";
import { KeyRound, MailCheck } from "@ionnet/iontronic/icons";
import { LIMITS } from "@shared/constants.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/forgot-password`: ask for a password link by username or email. The panel answers the same whether or not an
 * account matched, so the confirmation says "if".
 */
export default function ForgotPassword(_props: Props) {
  const auth = useAuth();
  const [login, setLogin] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await AuthApi.forgotPassword({ login: login.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (auth.meta && !auth.meta.mailEnabled) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={KeyRound}
            tone="warn"
            title="Password reset by email isn't set up"
            description="This panel doesn't send email. Ask an administrator to reset your password."
            actions={<Link to="/login">Back to sign in</Link>}
          />
        </CardBody>
      </Card>
    );
  }

  if (sent) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={MailCheck}
            tone="ok"
            title="Check your email"
            description={`If an account matches ${login.trim()}, we sent it a link to choose a new password. The link works for ${LIMITS.PASSWORD_RESET_TTL_MINUTES} minutes.`}
            actions={<Link to="/login">Back to sign in</Link>}
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Forgot your password?" description="Enter your username or email address. We'll email you a link to choose a new password." />
      <form onSubmit={submit}>
        <CardBody>
          <Stack gap="16">
            <Input label="Username or email" required autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={login} onChange={(event) => setLogin(event.target.value)} />
            <FormError>{error}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>Send the link</Button>
            <Link to="/login">Back to sign in</Link>
          </Stack>
        </CardBody>
      </form>
    </Card>
  );
}
