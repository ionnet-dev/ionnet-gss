import { useState } from "react";
import { Button, Card, CardBody, EmptyState, Stack } from "@ionnet/iontronic/react";
import { MailCheck, MailQuestion } from "@ionnet/iontronic/icons";
import type { ConfirmEmailResponse } from "@shared/api/auth.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/confirm-email?token=…`: opened from a confirmation email. The address is confirmed by the button, never by
 * opening the page: mail scanners and link previewers open every link in a message.
 */
export default function ConfirmEmail(props: Props) {
  const { match } = props;
  const auth = useAuth();
  const token = match.query.get("token");
  const [result, setResult] = useState<ConfirmEmailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!token) return;
    setError(null);
    setBusy(true);
    try {
      setResult(await AuthApi.confirmEmail({ token }));
      if (auth.isSignedIn()) await auth.refresh().catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const next = auth.isSignedIn()
    ? <Button variant="primary" onClick={() => navigate("/account")}>Go to your account</Button>
    : <Button variant="primary" onClick={() => navigate("/login")}>Go to sign in</Button>;

  if (!token) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={MailQuestion} tone="warn" title="This link is incomplete" description="Open the whole link from your email, or ask for a new one on your account page." actions={<Link to="/login">Go to sign in</Link>} />
        </CardBody>
      </Card>
    );
  }
  if (result) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon={MailCheck} tone="ok" title="Email address confirmed" description={`${result.email} is now confirmed for ${result.username}.`} actions={next} />
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody>
        <EmptyState
          icon={MailQuestion}
          title="Confirm your email address"
          description="Select the button to confirm the address this link was sent to."
          actions={
            <Stack gap="12" align="center">
              <FormError>{error}</FormError>
              <Button variant="primary" loading={busy} onClick={confirm}>Confirm email address</Button>
            </Stack>
          }
        />
      </CardBody>
    </Card>
  );
}
