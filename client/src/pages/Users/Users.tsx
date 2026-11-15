import { type FormEvent, useState } from "react";
import {
  AlertDialog, Avatar, Badge, Button, Card, CardBody, Checkbox, Dialog, EmptyState, Input, List, ListItem, Menu, Spinner,
  Stack, Switch,
} from "@ionnet/iontronic/react";
import { Ellipsis, KeyRound, Pencil, Trash2, UserPlus, Users as UsersIcon } from "@ionnet/iontronic/icons";
import { LIMITS, passwordProblem } from "@shared/constants.ts";
import { ROLES } from "@shared/permissions.ts";
import type { RoleDto, UserDto } from "@shared/api/users.ts";
import { UserApi } from "@/Api/UserApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { formatAgo } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import type { RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

type Dialogs =
  | { kind: "create" }
  | { kind: "edit" | "password" | "delete"; user: UserDto };

/**
 * `/users` (USERS_MANAGE): accounts, roles, passwords. The panel refuses to remove or demote the last admin; its
 * message shows as a toast.
 */
export default function Users(props: Props) {
  const auth = useAuth();
  const users = UserApi.useUsers();
  const roles = UserApi.useRoles();
  const notify = useNotify();
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const close = () => setDialog(null);

  const remove = async (user: UserDto) => {
    try {
      await UserApi.remove(user.id);
      notify.ok(`Deleted ${user.username}`);
      if (user.id === auth.user?.id) auth.signOut();
      else await users.reload();
    } catch (error) {
      notify.error(error, `Couldn't delete ${user.username}`);
    }
  };

  return (
    <Stack gap="16">
      <PageHeader
        title="Users"
        description="Everyone who can sign in to this panel."
        actions={<Button variant="primary" icon={UserPlus} onClick={() => setDialog({ kind: "create" })}>Add user</Button>}
      />
      <Card>
        <CardBody>
          {users.data === null && users.loading && <Stack align="center"><Spinner label="Loading users" /></Stack>}
          {users.data === null && users.error && <LoadError title="Couldn't load the users" error={users.error} onRetry={users.reload} />}
          {users.data?.length === 0 && <EmptyState icon={UsersIcon} title="No users" description="Add the first account." />}
          {users.data && users.data.length > 0 && (
            <List>
              {users.data.map((user) => (
                <ListItem
                  key={user.id}
                  leading={<Avatar name={user.username} />}
                  title={user.displayName ?? user.username}
                  badges={
                    <>
                      {user.roles.map((role) => <Badge key={role} size="sm" tone={role === ROLES.ADMIN ? "accent" : "neutral"}>{role}</Badge>)}
                      {user.disabled && <Badge size="sm" tone="bad">Disabled</Badge>}
                      {user.totpEnabled && <Badge size="sm" tone="ok">2FA</Badge>}
                      {user.id === auth.user?.id && <Badge size="sm" tone="info">You</Badge>}
                    </>
                  }
                  description={user.displayName ? `${user.username}${user.email ? ` · ${user.email}` : ""}` : user.email ?? undefined}
                  meta={user.lastLoginAt ? `Last sign-in ${formatAgo(user.lastLoginAt)}` : "Never signed in"}
                  trailing={
                    <Menu.Root>
                      <Menu.Trigger variant="ghost" size="sm" iconOnly icon={Ellipsis} aria-label={`Actions for ${user.username}`} />
                      <Menu.Content align="end">
                        <Menu.Item icon={Pencil} onClick={() => setDialog({ kind: "edit", user })}>Edit</Menu.Item>
                        <Menu.Item icon={KeyRound} onClick={() => setDialog({ kind: "password", user })}>Reset password</Menu.Item>
                        <Menu.Separator />
                        <Menu.Item tone="bad" icon={Trash2} onClick={() => setDialog({ kind: "delete", user })}>Delete</Menu.Item>
                      </Menu.Content>
                    </Menu.Root>
                  }
                />
              ))}
            </List>
          )}
        </CardBody>
      </Card>

      {dialog?.kind === "create" && <CreateUserDialog roles={roles.data ?? []} onClose={close} onDone={users.reload} />}
      {dialog?.kind === "edit" && <EditUserDialog user={dialog.user} roles={roles.data ?? []} onClose={close} onDone={users.reload} />}
      {dialog?.kind === "password" && <PasswordDialog user={dialog.user} onClose={close} />}

      <AlertDialog.Root open={dialog?.kind === "delete"} onOpenChange={(open) => !open && close()}>
        <AlertDialog.Content
          title={`Delete ${dialog?.kind === "delete" ? dialog.user.username : ""}?`}
          description="Their account and sessions are removed. The last admin can't be deleted."
        >
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => dialog?.kind === "delete" && remove(dialog.user)}>Delete</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Stack>
  );
}

/**
 * One checkbox per role; at least one must stay checked.
 */
function RolePicker(props: { roles: RoleDto[]; value: string[]; onChange: (value: string[]) => void; error?: string }) {
  const { roles, value, onChange, error } = props;
  return (
    <Stack gap="8">
      <span className="io-label">Roles</span>
      {roles.map((role) => (
        <Checkbox
          key={role.id}
          label={role.name}
          description={role.description ?? undefined}
          checked={value.includes(role.name)}
          onCheckedChange={(checked) => onChange(checked ? [...value, role.name] : value.filter((name) => name !== role.name))}
        />
      ))}
      <FormError>{error}</FormError>
    </Stack>
  );
}

function CreateUserDialog(props: { roles: RoleDto[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { roles, onClose, onDone } = props;
  const notify = useNotify();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [selected, setSelected] = useState<string[]>([ROLES.USER]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!LIMITS.USERNAME_PATTERN.test(username)) found.username = "Use 3 to 32 letters, numbers, dots, dashes or underscores.";
    const passwordError = passwordProblem(password);
    if (passwordError) found.password = passwordError;
    if (selected.length === 0) found.roles = "Pick at least one role.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await UserApi.create({ username, password, email: email.trim() || null, roles: selected });
      notify.ok(`Added ${username}`);
      await onDone();
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content title="Add user" description="Share the password with them. They can change it under Account.">
        <form onSubmit={submit} noValidate>
          <Dialog.Body>
            <Stack gap="16">
              <Input label="Username" required autoFocus autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} error={errors.username} />
              <Input label="Email" type="email" description="Optional." autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
              <Input label="Password" type="password" required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} error={errors.password} />
              <RolePicker roles={roles} value={selected} onChange={setSelected} error={errors.roles} />
              <FormError>{formError}</FormError>
            </Stack>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" loading={busy}>Add user</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function EditUserDialog(props: { user: UserDto; roles: RoleDto[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { user, roles, onClose, onDone } = props;
  const auth = useAuth();
  const notify = useNotify();
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [selected, setSelected] = useState<string[]>(user.roles);
  const [disabled, setDisabled] = useState(user.disabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selected.length === 0) {
      setError("Pick at least one role.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await UserApi.update(user.id, { displayName: displayName.trim() || null, email: email.trim() || null, roles: selected, disabled });
      // Changing your own roles ends your old session; the panel answers with a fresh token for this tab.
      if (updated.token) auth.adoptSession(updated.token, updated);
      notify.ok(`Saved ${user.username}`);
      await onDone();
      onClose();
    } catch (err) {
      // The panel refuses to demote or disable the last admin; its message says so.
      notify.error(err, `Couldn't save ${user.username}`);
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content title={`Edit ${user.username}`}>
        <form onSubmit={submit} noValidate>
          <Dialog.Body>
            <Stack gap="16">
              <Input label="Display name" description="Optional." value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              <Input label="Email" type="email" description="Optional." value={email} onChange={(event) => setEmail(event.target.value)} />
              <RolePicker roles={roles} value={selected} onChange={setSelected} error={error ?? undefined} />
              <Switch label="Disabled" description="A disabled user is signed out and can't sign in." checked={disabled} onCheckedChange={setDisabled} />
            </Stack>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" loading={busy}>Save</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function PasswordDialog(props: { user: UserDto; onClose: () => void }) {
  const { user, onClose } = props;
  const notify = useNotify();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const passwordError = passwordProblem(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    setBusy(true);
    try {
      await UserApi.setPassword(user.id, { password });
      notify.ok(`Password reset for ${user.username}`, "Their other sessions were signed out.");
      onClose();
    } catch (err) {
      notify.error(err, "Couldn't reset the password");
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content title={`Reset password for ${user.username}`} description="They are signed out everywhere and use the new password from now on.">
        <form onSubmit={submit} noValidate>
          <Dialog.Body>
            <Input label="New password" type="password" required autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} error={error ?? undefined} />
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" loading={busy}>Reset password</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
