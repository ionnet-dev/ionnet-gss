import { type FormEvent, useState } from "react";
import { AlertDialog, Button, Card, CardBody, CardFooter, CardHeader, EmptyState, Input, Select, Spinner, Stack, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ionnet/iontronic/react";
import { Trash2, UserPlus, Users } from "@ionnet/iontronic/icons";
import type { GameServerDto, ServerShareDto, ServerShareRole } from "@shared/api/servers.ts";
import { LIMITS } from "@shared/constants.ts";
import { ShareApi } from "@/Api/ShareApi.ts";
import { formatAgo } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";

interface Props {
  server: GameServerDto;
}

const ROLE_OPTIONS: { value: ServerShareRole; label: string }[] = [
  { value: "view", label: "View" },
  { value: "operate", label: "Operate" },
  { value: "manage", label: "Manage" },
];

const ROLE_HELP = "View: console and stats. Operate: also start, stop, restart and send commands. Manage: also settings, files, backups and updates. Only you can delete the server or change who it is shared with.";

/**
 * Server page "Sharing" tab (owner level): list of shares with a role select each, remove, and "Share" by username +
 * role (`ShareApi`). For a shared user the server page offers "Leave" instead (not this component). M5, parcel B.
 */
export default function ServerSharing(props: Props) {
  const { server } = props;
  const notify = useNotify();
  const shares = ShareApi.useShares(server.id);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<ServerShareRole>("view");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ServerShareDto | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    try {
      await ShareApi.add(server.id, { username: name, role });
      setUsername("");
      await shares.reload();
      notify.ok("Server shared", `${name} can now open this server.`);
    } catch (error) {
      notify.error(error, "Couldn't share the server");
    } finally {
      setBusy(false);
    }
  };

  const change = async (share: ServerShareDto, next: ServerShareRole) => {
    if (next === share.role) return;
    try {
      await ShareApi.update(server.id, share.userId, { role: next });
      await shares.reload();
    } catch (error) {
      notify.error(error, "Couldn't change the role");
      await shares.reload();
    }
  };

  const remove = async (share: ServerShareDto) => {
    try {
      await ShareApi.remove(server.id, share.userId);
      await shares.reload();
      notify.ok("Access removed", `${share.username} can no longer open this server.`);
    } catch (error) {
      notify.error(error, "Couldn't remove the access");
    }
  };

  const data = shares.data;
  const atLimit = data !== null && data.length >= LIMITS.SHARES_PER_SERVER;

  return (
    <Card>
      <CardHeader title="Sharing" description="Let other people on this panel use this server. They find it in their own server list." />
      <CardBody>
        <Stack gap="16">
          {data === null && shares.loading && <Stack align="center"><Spinner label="Loading shares" /></Stack>}
          {data === null && shares.error && <LoadError title="Couldn't load the shares" error={shares.error} onRetry={shares.reload} />}
          {data && (
            <>
              {shares.error && <LoadError title="Couldn't refresh the shares" error={shares.error} onRetry={shares.reload} />}
              {data.length === 0
                ? <EmptyState size="sm" icon={Users} title="Not shared yet" description="Only you can open this server. Add a username below to give someone access." />
                : (
                  <Table plain density="compact" aria-label="Shares">
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Added</TableHead>
                        <TableHead><span className="io-visually-hidden">Actions</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.map((share) => (
                        <TableRow key={share.userId}>
                          <TableCell>
                            <Stack gap="4">
                              <span>{share.displayName ?? share.username}</span>
                              {share.displayName && <span className="io-text-muted">{share.username}</span>}
                            </Stack>
                          </TableCell>
                          <TableCell>
                            <Select
                              aria-label={`Role of ${share.username}`}
                              options={ROLE_OPTIONS}
                              value={share.role}
                              onValueChange={(value) => value !== null && change(share, value)}
                            />
                          </TableCell>
                          <TableCell>{formatAgo(share.createdAt)}</TableCell>
                          <TableCell>
                            <Button variant="ghost" size="sm" iconOnly icon={Trash2} aria-label={`Remove ${share.username}`} onClick={() => setRemoving(share)} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
            </>
          )}
        </Stack>
      </CardBody>
      <CardFooter>
        <form onSubmit={add} style={{ width: "100%" }}>
          <Stack gap="12">
            <Stack direction="row" gap="12" align="end" wrap>
              <Input label="Username" value={username} maxLength={32} autoComplete="off" disabled={atLimit} onChange={(event) => setUsername(event.target.value)} />
              <Select label="Role" options={ROLE_OPTIONS} value={role} onValueChange={(value) => value !== null && setRole(value)} />
              <Button type="submit" variant="primary" icon={UserPlus} loading={busy} disabled={username.trim() === "" || atLimit}>Share</Button>
            </Stack>
            <span className="io-text-muted" role="note">{atLimit ? `A server can be shared with at most ${LIMITS.SHARES_PER_SERVER} people.` : ROLE_HELP}</span>
          </Stack>
        </form>
      </CardFooter>
      <AlertDialog.Root open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialog.Content title={`Remove ${removing?.username ?? "this user"}?`} description="They lose access to this server at once. Their console stream stops and the server leaves their list.">
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => removing && remove(removing)}>Remove access</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Card>
  );
}
