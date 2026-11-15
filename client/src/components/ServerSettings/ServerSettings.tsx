import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AlertDialog, Button, Card, CardBody, CardFooter, CardHeader, Checkbox, Dialog, Icon, Input, Stack, Switch } from "@ionnet/iontronic/react";
import { Lock, Trash2 } from "@ionnet/iontronic/icons";
import { LIMITS } from "@shared/constants.ts";
import type { GameServerDetailResponse, UpdateServerBody } from "@shared/api/servers.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import VariableForm, {
  errorFieldFor,
  type FormErrors,
  type FormValues,
  fromServer,
  initialValues,
  toValues,
  useVariableOptions,
  validate,
} from "@/components/VariableForm/VariableForm.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { navigate } from "@/router/Router.tsx";

/**
 * The admin-only switch for `allowPrivateNetwork`, shared with the create flow.
 */
export const PRIVATE_NETWORK_LABEL = "Allow access to private networks";
export const PRIVATE_NETWORK_DESCRIPTION = "Off: the server reaches only the public internet, not your LAN, the host or other servers. Turn it on for a game that must talk to services on your own network.";

export interface ServerSettingsProps {
  server: GameServerDetailResponse;
  /**
   * Refetch the server after a change.
   */
  onChanged: () => Promise<void>;
}

const STATE_NAMES: Record<string, string> = {
  creating: "being created",
  installing: "installing",
  install_failed: "not installed",
  starting: "starting",
  running: "running",
  stopping: "stopping",
  crashed: "crashed",
};

/**
 * The settings tab: rename, the variables form, start behaviour, and delete. Everything is read-only unless the server
 * is stopped (the panel answers 409 otherwise); a change to a `reinstall` variable asks before saving.
 */
export default function ServerSettings(props: ServerSettingsProps) {
  const { server, onChanged } = props;
  const editable = server.state === "stopped";
  return (
    <Stack gap="16">
      <SettingsForm server={server} editable={editable} onChanged={onChanged} />
      <DeleteCard server={server} />
    </Stack>
  );
}

function SettingsForm(props: { server: GameServerDetailResponse; editable: boolean; onChanged: () => Promise<void> }) {
  const { server, editable, onChanged } = props;
  const notify = useNotify();
  const declared = useMemo(() => fromServer(server.variables), [server.variables]);
  const variables = useVariableOptions(server.definition.id, declared);
  const initial = useMemo(() => initialValues(declared), [declared]);

  const [name, setName] = useState(server.name);
  const [values, setValues] = useState<FormValues>(initial);
  const [autostart, setAutostart] = useState(server.autostart);
  const [autoRestart, setAutoRestart] = useState(server.autoRestart);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(server.allowPrivateNetwork);
  const canAllowPrivateNetwork = useAuth().has("SERVERS_PRIVATE_NETWORK");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Start from what the panel holds again whenever it changes (after a save, or an edit made elsewhere).
  useEffect(() => {
    setName(server.name);
    setValues(initial);
    setAutostart(server.autostart);
    setAutoRestart(server.autoRestart);
    setAllowPrivateNetwork(server.allowPrivateNetwork);
    setErrors({});
  }, [server.name, server.autostart, server.autoRestart, server.allowPrivateNetwork, initial]);

  const changed = toValues(variables, values, initial);
  const reinstalls = variables.filter((variable) => variable.reinstall && variable.key in changed);
  const dirty = name.trim() !== server.name || Object.keys(changed).length > 0 || autostart !== server.autostart || autoRestart !== server.autoRestart || allowPrivateNetwork !== server.allowPrivateNetwork;

  const save = async () => {
    setBusy(true);
    setFormError(null);
    const body: UpdateServerBody = {};
    if (name.trim() !== server.name) body.name = name.trim();
    if (Object.keys(changed).length > 0) body.variables = changed;
    if (autostart !== server.autostart) body.autostart = autostart;
    if (autoRestart !== server.autoRestart) body.autoRestart = autoRestart;
    if (allowPrivateNetwork !== server.allowPrivateNetwork) body.allowPrivateNetwork = allowPrivateNetwork;
    try {
      const result = await ServerApi.update(server.id, body);
      await onChanged();
      if (result.reinstallPending) notify.ok("Settings saved", "The server reinstalls the next time it starts.");
      else notify.ok("Settings saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = errorFieldFor(message, variables);
      if (key) setErrors({ [key]: message });
      else if (/name/i.test(message)) setErrors({ name: message });
      else setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(variables, values);
    if (!name.trim()) found.name = "Give the server a name.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    if (reinstalls.length > 0) setConfirmOpen(true);
    else save();
  };

  return (
    <Card>
      <CardHeader title="Settings" description="Changes apply the next time the server starts." />
      <form onSubmit={submit} noValidate>
        <CardBody>
          <Stack gap="24">
            {!editable && (
              <Stack direction="row" gap="8" align="start" role="note">
                <Icon icon={Lock} size="md" />
                <span className="io-text-muted">
                  Settings can only be changed while the server is stopped. It is {STATE_NAMES[server.state] ?? server.state} now.
                </span>
              </Stack>
            )}
            <Input
              label="Server name"
              required
              value={name}
              maxLength={LIMITS.SERVER_NAME_MAX}
              disabled={!editable || busy}
              onChange={(event) => setName(event.target.value)}
              error={errors.name}
            />
            <VariableForm
              variables={variables}
              values={values}
              errors={errors}
              disabled={!editable || busy}
              editing
              onChange={(key, value) => {
                setValues((current) => ({ ...current, [key]: value }));
                setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => field !== key)));
              }}
            />
            <Stack gap="12">
              <Switch label="Start with the host" description="Start this server again when its host comes back." checked={autostart} onCheckedChange={setAutostart} disabled={!editable || busy} />
              <Switch label="Restart after a crash" description="Start it again when the game stops unexpectedly." checked={autoRestart} onCheckedChange={setAutoRestart} disabled={!editable || busy} />
              {canAllowPrivateNetwork && (
                <Switch label={PRIVATE_NETWORK_LABEL} description={PRIVATE_NETWORK_DESCRIPTION} checked={allowPrivateNetwork} onCheckedChange={setAllowPrivateNetwork} disabled={!editable || busy} />
              )}
            </Stack>
            <FormError>{formError}</FormError>
          </Stack>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={busy} disabled={!editable || !dirty}>Save changes</Button>
        </CardFooter>
      </form>
      <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialog.Content
          title="Reinstall on the next start?"
          description={`Changing ${reinstalls.map((variable) => variable.label).join(", ")} makes the server run its install again the next time it starts. Its world and other files stay, but files the installer manages are replaced.`}
        >
          <AlertDialog.Footer>
            <AlertDialog.Close>Cancel</AlertDialog.Close>
            <AlertDialog.Close variant="primary" onClick={save}>Save and reinstall</AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Card>
  );
}

/**
 * Delete with the server's name typed as confirmation.
 */
function DeleteCard(props: { server: GameServerDetailResponse }) {
  const { server } = props;
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [keepData, setKeepData] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await ServerApi.remove(server.id, keepData);
      notify.ok("Server deleted");
      navigate("/servers");
    } catch (error) {
      notify.error(error, "Couldn't delete the server");
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Delete this server" description="Removes the server and, unless you keep it, everything it saved: worlds, configs and logs." />
      <CardFooter>
        <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); setTyped(""); setKeepData(false); }}>
          <Dialog.Trigger variant="danger" icon={Trash2}>Delete server</Dialog.Trigger>
          <Dialog.Content title={`Delete ${server.name}?`} description="This can't be undone. Type the server's name to confirm." size="sm">
            <form onSubmit={(event) => { event.preventDefault(); if (typed === server.name) remove(); }}>
              <Dialog.Body>
                <Stack gap="16">
                  <Input label="Server name" description={<>Type <strong>{server.name}</strong></>} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
                  <Checkbox label="Keep the server's files on the host" description="The server is removed from the panel, but its data folder stays." checked={keepData} onCheckedChange={setKeepData} />
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.Close>Cancel</Dialog.Close>
                <Button type="submit" variant="danger" loading={busy} disabled={typed !== server.name}>Delete server</Button>
              </Dialog.Footer>
            </form>
          </Dialog.Content>
        </Dialog.Root>
      </CardFooter>
    </Card>
  );
}
