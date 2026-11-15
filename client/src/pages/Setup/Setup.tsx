import { type FormEvent, useState } from "react";
import { Button, Card, CardBody, CardHeader, Input, Stack } from "@ionnet/iontronic/react";
import { LIMITS, passwordProblem } from "@shared/constants.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/setup`, first run only: create the first admin (username, optional email, password twice).
 */
export default function Setup(props: Props) {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
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
      await auth.setup({ username, password, email: email.trim() || null });
      navigate("/hosts");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Welcome to Ionnet GSS" description="Create the first admin account. You can invite everyone else afterwards." />
      <form onSubmit={submit} noValidate>
        <CardBody>
          <Stack gap="16">
            <Input label="Username" required autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} error={errors.username} />
            <Input label="Email" type="email" autoComplete="email" description="Optional." value={email} onChange={(event) => setEmail(event.target.value)} />
            <Input label="Password" type="password" required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} error={errors.password} />
            <Input label="Repeat password" type="password" required autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} error={errors.confirm} />
            <FormError>{formError}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>Create admin</Button>
          </Stack>
        </CardBody>
      </form>
    </Card>
  );
}
