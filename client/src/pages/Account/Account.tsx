import { type FormEvent, useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Input, SegmentedControl, Stack, useTheme, type ThemeMode } from "@ionnet/iontronic/react";
import { LogOut, Monitor, Moon, Sun } from "@ionnet/iontronic/icons";
import { passwordProblem } from "@shared/constants.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import QuotaUsage from "@/components/QuotaUsage/QuotaUsage.tsx";
import TwoFactorCard from "@/components/TwoFactorCard/TwoFactorCard.tsx";
import { QuotaApi } from "@/Api/QuotaApi.ts";
import { useAuth } from "@/hooks/useAuth.ts";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/account`: who you are, change your password, pick a theme, sign out. M5: two-factor setup.
 */
export default function Account(props: Props) {
  const auth = useAuth();
  const theme = useTheme();
  const quota = QuotaApi.useMine();

  return (
    <Stack gap="16">
      <PageHeader
        title="Account"
        actions={
          <Button
            icon={LogOut}
            onClick={() => {
              auth.signOut();
              navigate("/login");
            }}
          >
            Sign out
          </Button>
        }
      />
      <Card>
        <CardHeader
          title={auth.user?.displayName ?? auth.user?.username ?? "Account"}
          description={auth.user?.email ?? auth.user?.username}
          actions={<Stack direction="row" gap="4" wrap>{auth.user?.roles.map((role) => <Badge key={role} size="sm" tone="accent">{role}</Badge>)}</Stack>}
        />
      </Card>
      <PasswordForm />
      <TwoFactorCard />
      {quota.data && <QuotaUsage quota={quota.data} />}
      <Card>
        <CardHeader title="Theme" description="Follows your system unless you pick one." />
        <CardBody>
          <SegmentedControl<ThemeMode>
            aria-label="Theme"
            value={theme.mode}
            onValueChange={theme.setMode}
            options={[
              { value: "system", label: "System", icon: Monitor },
              { value: "light", label: "Light", icon: Sun },
              { value: "dark", label: "Dark", icon: Moon },
            ]}
          />
        </CardBody>
      </Card>
    </Stack>
  );
}

function PasswordForm() {
  const auth = useAuth();
  const notify = useNotify();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!current) found.current = "Enter your current password.";
    const nextError = passwordProblem(next);
    if (nextError) found.next = nextError;
    if (confirm !== next) found.confirm = "The passwords don't match.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      // Every other session ends; the response is a fresh session for this one.
      await auth.changePassword({ currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      notify.ok("Password changed", "Your other sessions were signed out.");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Change password" />
      <form onSubmit={submit} noValidate>
        <CardBody>
          <Stack gap="16">
            <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} error={errors.current} />
            <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} error={errors.next} />
            <Input label="Repeat new password" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} error={errors.confirm} />
            <FormError>{formError}</FormError>
          </Stack>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={busy}>Change password</Button>
        </CardFooter>
      </form>
    </Card>
  );
}
