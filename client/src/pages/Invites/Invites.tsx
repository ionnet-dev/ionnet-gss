import { type FormEvent, useState } from "react";
import { Badge, Button, Card, CardBody, CodeBlock, Dialog, EmptyState, Input, List, ListItem, Select, Spinner, Stack } from "@ionnet/iontronic/react";
import { Plus, Ticket } from "@ionnet/iontronic/icons";
import { ROLES } from "@shared/permissions.ts";
import type { InviteCreatedResponse, InviteDto } from "@shared/api/invites.ts";
import { InviteApi } from "@/Api/InviteApi.ts";
import { UserApi } from "@/Api/UserApi.ts";
import { formatAgo, formatDateTime } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import type { RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

const EXPIRY_OPTIONS = [
  { value: 24, label: "1 day" },
  { value: 72, label: "3 days" },
  { value: 24 * 7, label: "7 days" },
];

/**
 * `/invites` (INVITES_MANAGE): one-time registration links. The link is shown once, right after it is created.
 */
export default function Invites(props: Props) {
  const invites = InviteApi.useInvites();
  const notify = useNotify();
  const [creating, setCreating] = useState(false);

  const revoke = async (invite: InviteDto) => {
    try {
      await InviteApi.revoke(invite.id);
      await invites.reload();
      notify.ok("Invite revoked");
    } catch (error) {
      notify.error(error, "Couldn't revoke the invite");
    }
  };

  return (
    <Stack gap="16">
      <PageHeader
        title="Invites"
        description="One-time links that let someone create an account."
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Create invite</Button>}
      />
      <Card>
        <CardBody>
          {invites.data === null && invites.loading && <Stack align="center"><Spinner label="Loading invites" /></Stack>}
          {invites.data === null && invites.error && <LoadError title="Couldn't load the invites" error={invites.error} onRetry={invites.reload} />}
          {invites.data?.length === 0 && (
            <EmptyState
              icon={Ticket}
              title="No invites yet"
              description="Create an invite and send the link to the person you want to add. It works once."
              actions={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Create invite</Button>}
            />
          )}
          {invites.data && invites.data.length > 0 && (
            <List>
              {invites.data.map((invite) => <InviteItem key={invite.id} invite={invite} onRevoke={() => revoke(invite)} />)}
            </List>
          )}
        </CardBody>
      </Card>
      {creating && <CreateInviteDialog onClose={() => setCreating(false)} onCreated={invites.reload} />}
    </Stack>
  );
}

function InviteItem(props: { invite: InviteDto; onRevoke: () => void }) {
  const { invite, onRevoke } = props;
  const expired = !invite.usedAt && new Date(invite.expiresAt).getTime() <= Date.now();
  const state = invite.usedAt
    ? <Badge size="sm" tone="ok">Used</Badge>
    : expired
    ? <Badge size="sm" tone="neutral">Expired</Badge>
    : <Badge size="sm" tone="info">Waiting</Badge>;
  const details = [
    invite.email ?? "Any email",
    `role ${invite.role}`,
    invite.createdBy ? `by ${invite.createdBy}` : null,
  ].filter(Boolean).join(" · ");
  const meta = invite.usedAt
    ? `Used by ${invite.usedBy ?? "someone"} ${formatAgo(invite.usedAt)}`
    : expired
    ? `Expired ${formatAgo(invite.expiresAt)}`
    : `Expires ${formatDateTime(invite.expiresAt)}`;
  return (
    <ListItem
      icon={Ticket}
      tone={invite.usedAt ? "ok" : expired ? "neutral" : "accent"}
      title={<span className="io-mono">…{invite.codeHint}</span>}
      badges={state}
      description={details}
      meta={meta}
      trailing={invite.usedAt ? undefined : <Button size="sm" variant="ghost" onClick={onRevoke}>Revoke</Button>}
    />
  );
}

function CreateInviteDialog(props: { onClose: () => void; onCreated: () => Promise<void> }) {
  const { onClose, onCreated } = props;
  const notify = useNotify();
  const roles = UserApi.useRoles();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(ROLES.USER);
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<InviteCreatedResponse | null>(null);

  const roleOptions = (roles.data ?? [{ id: 0, name: ROLES.USER }]).map((r) => ({ value: r.name, label: r.name }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      setCreated(await InviteApi.create({ email: email.trim() || null, role, expiresInHours }));
      await onCreated();
    } catch (error) {
      notify.error(error, "Couldn't create the invite");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content
        title={created ? "Invite created" : "Create invite"}
        description={created ? undefined : "The link lets one person register with the role you pick."}
      >
        {created
          ? (
            <>
              <Dialog.Body>
                <Stack gap="12">
                  <span>Send this link to the person you are inviting:</span>
                  <CodeBlock code={created.url} wrap copyLabel="Copy invite link" label="Invite link" />
                  <span className="io-text-muted">
                    It works once and expires {formatDateTime(created.invite.expiresAt)}. This link is not shown again.
                  </span>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="primary" onClick={onClose}>Done</Button>
              </Dialog.Footer>
            </>
          )
          : (
            <form onSubmit={submit}>
              <Dialog.Body>
                <Stack gap="16">
                  <Input label="Email" type="email" description="Optional. When set, the new account uses this address." autoFocus value={email} onChange={(event) => setEmail(event.target.value)} />
                  <Select label="Role" options={roleOptions} value={role} onValueChange={(value) => value !== null && setRole(value)} />
                  <Select label="Valid for" options={EXPIRY_OPTIONS} value={expiresInHours} onValueChange={(value) => value !== null && setExpiresInHours(value)} />
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.Close>Cancel</Dialog.Close>
                <Button type="submit" variant="primary" loading={busy}>Create invite</Button>
              </Dialog.Footer>
            </form>
          )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
