import { type FormEvent, useState } from "react";
import { AlertDialog, Button, Card, CardBody, CardFooter, CardHeader, EmptyState, Input, Spinner, Stack, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ionnet/iontronic/react";
import { Trash2, UserPlus, Users } from "@ionnet/iontronic/icons";
import type { HostGrantDto } from "@shared/api/hosts.ts";
import { HostApi } from "@/Api/HostApi.ts";
import { formatAgo } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";

interface Props {
  hostId: string;
}

/**
 * Host page card (HOSTS_MANAGE): users granted this host, add by username, revoke with a confirm that says their
 * servers stay (`HostApi.useGrants` / `addGrant` / `removeGrant`). M5, parcel D.
 */
export default function HostGrants(props: Props) {
  const { hostId } = props;
  const notify = useNotify();
  const grants = HostApi.useGrants(hostId);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<HostGrantDto | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    try {
      await HostApi.addGrant(hostId, { username: name });
      setUsername("");
      await grants.reload();
      notify.ok("Access granted", `${name} can now create servers on this host.`);
    } catch (error) {
      notify.error(error, "Couldn't give access");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grant: HostGrantDto) => {
    try {
      await HostApi.removeGrant(hostId, grant.userId);
      await grants.reload();
      notify.ok("Access revoked", `${grant.username} can no longer create servers on this host.`);
    } catch (error) {
      notify.error(error, "Couldn't revoke the access");
      await grants.reload();
    }
  };

  const data = grants.data;

  return (
    <Card>
      <CardHeader
        title="Access"
        description="People who may create servers on this host. Admins and users who can manage all servers don't need a grant."
      />
      <CardBody>
        <Stack gap="16">
          {data === null && grants.loading && <Stack align="center"><Spinner label="Loading access" /></Stack>}
          {data === null && grants.error && <LoadError title="Couldn't load who has access" error={grants.error} onRetry={grants.reload} />}
          {data && (
            <>
              {grants.error && <LoadError title="Couldn't refresh who has access" error={grants.error} onRetry={grants.reload} />}
              {data.length === 0
                ? <EmptyState size="sm" icon={Users} title="Nobody has been granted this host" description="Add a username below to let someone create servers here." />
                : (
                  <Table plain density="compact" aria-label="Users with access to this host">
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Granted</TableHead>
                        <TableHead><span className="io-visually-hidden">Actions</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.map((grant) => (
                        <TableRow key={grant.userId}>
                          <TableCell>{grant.username}</TableCell>
                          <TableCell>{formatAgo(grant.createdAt)}</TableCell>
                          <TableCell>
                            <Button variant="ghost" size="sm" iconOnly icon={Trash2} aria-label={`Revoke access of ${grant.username}`} onClick={() => setRevoking(grant)} />
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
          <Stack direction="row" gap="12" align="end" wrap>
            <Input label="Username" value={username} maxLength={32} autoComplete="off" onChange={(event) => setUsername(event.target.value)} />
            <Button type="submit" variant="primary" icon={UserPlus} loading={busy} disabled={username.trim() === ""}>Give access</Button>
          </Stack>
        </form>
      </CardFooter>
      <AlertDialog.Root open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialog.Content
          title={`Revoke access of ${revoking?.username ?? "this user"}?`}
          description="They can't create new servers on this host any more. Servers they already have here keep running and stay theirs to operate."
        >
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="danger" onClick={() => revoking && revoke(revoking)}>Revoke access</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Card>
  );
}
