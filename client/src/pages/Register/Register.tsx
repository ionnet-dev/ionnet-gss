import { type FormEvent, useEffect, useState } from "react";
import { Button, Card, CardBody, CardHeader, EmptyState, Input, Spinner, Stack } from "@ionnet/iontronic/react";
import { Ticket } from "@ionnet/iontronic/icons";
import { LIMITS, passwordProblem } from "@shared/constants.ts";
import type { InvitePreviewResponse } from "@shared/api/auth.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/register?code=…`: checks the invite, then asks for a username and password. An invite that names an email locks it.
 */
export default function Register(props: Props) {
  const { match } = props;
  const code = match.query.get("code");
  const [invite, setInvite] = useState<InvitePreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    setInvite(null);
    setLoadError(null);
    AuthApi.previewInvite(code).then(
      (preview) => !cancelled && setInvite(preview),
      (error) => !cancelled && setLoadError(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  const toLogin = <Button onClick={() => navigate("/login")}>Go to sign in</Button>;

  if (!code) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={Ticket} title="No invite code" description="Registration needs an invite link from an admin." actions={toLogin} />
        </CardBody>
      </Card>
    );
  }
  if (loadError) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={Ticket} tone="bad" title="Couldn't check your invite" description={loadError} actions={toLogin} />
        </CardBody>
      </Card>
    );
  }
  if (!invite) {
    return (
      <Card>
        <CardBody><Stack align="center"><Spinner label="Checking your invite" /></Stack></CardBody>
      </Card>
    );
  }
  if (!invite.valid) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={Ticket} tone="warn" title="This invite can't be used" description="It has expired, was already used, or was revoked. Ask an admin for a new one." actions={toLogin} />
        </CardBody>
      </Card>
    );
  }
  return <RegisterForm code={code} invite={invite} />;
}

function RegisterForm(props: { code: string; invite: InvitePreviewResponse }) {
  const { code, invite } = props;
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState(invite.email ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!LIMITS.USERNAME_PATTERN.test(username)) found.username = "Use 3 to 32 letters, numbers, dots, dashes or underscores.";
    const passwordError = passwordProblem(password);
    if (passwordError) found.password = passwordError;
    if (confirm !== password) found.confirm = "The passwords don't match.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await auth.register({ inviteCode: code, username, password, email: email.trim() || null });
      navigate("/hosts");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Join Ionnet GSS" description="You've been invited. Choose a username and password to create your account." />
      <form onSubmit={submit} noValidate>
        <CardBody>
          <Stack gap="16">
            <Input label="Username" required autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} error={errors.username} />
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              description={invite.email ? "Set by the invite." : "Optional."}
              value={email}
              readOnly={invite.email !== null}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input label="Password" type="password" required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} error={errors.password} />
            <Input label="Repeat password" type="password" required autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} error={errors.confirm} />
            <FormError>{formError}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>Create account</Button>
          </Stack>
        </CardBody>
      </form>
    </Card>
  );
}
