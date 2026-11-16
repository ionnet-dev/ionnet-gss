import { type FormEvent, useState } from "react";
import { Button, CodeBlock, Dialog, Input, Select, Stack } from "@ionnet/iontronic/react";
import { Plus } from "@ionnet/iontronic/icons";
import { LIMITS } from "@shared/constants.ts";
import type { EnrolTokenCreatedResponse } from "@shared/api/hosts.ts";
import { HostApi } from "@/Api/HostApi.ts";
import { formatDateTime } from "@/components/Format/format.ts";
import { useNotify } from "@/components/Notify/useNotify.ts";

export interface EnrolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EXPIRY_OPTIONS = [
  { value: 15, label: "15 minutes" },
  { value: 60, label: "1 hour" },
  { value: 24 * 60, label: "24 hours" },
];

/**
 * "Enrol a host": creates a one-time enrol token and shows the command to run on the machine. The token is only in
 * this response, so the command is shown once, with a copy button and its expiry.
 */
export default function EnrolDialog(props: EnrolDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        title="Enrol a host"
        description="Add a machine that runs gss-agent. The token below works once and expires."
        size="lg"
      >
        <EnrolForm onClose={() => onOpenChange(false)} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function EnrolForm(props: { onClose: () => void }) {
  const { onClose } = props;
  const notify = useNotify();
  const [name, setName] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<EnrolTokenCreatedResponse | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      setCreated(await HostApi.createEnrolToken({ name: name.trim() || null, expiresInMinutes }));
    } catch (error) {
      notify.error(error, "Couldn't create the enrol token");
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    // The panel adds --insecure to the enrol command exactly when its address is plain http:// on another machine.
    const insecure = created.command.includes(" --insecure");
    return (
      <>
        <Dialog.Body>
          <Stack gap="16">
            {insecure && (
              <span role="alert" style={{ color: "var(--io-color-hue-text-warn)" }}>
                This panel is on plain http://, so the script and the agent download can be altered on the way. Only use it on a trusted network; use HTTPS for real hosts.
              </span>
            )}
            <Stack gap="8">
              <span>On the machine (Arch Linux, or Debian/Ubuntu with systemd), run this as a user who can use <span className="io-mono">sudo</span>. It installs Docker if needed, downloads the agent from this panel, enrols the host and starts it:</span>
              <CodeBlock code={created.installCommand} language="bash" title="Install and enrol" wrap copyLabel="Copy install command" />
            </Stack>
            <Stack gap="8">
              <span>The script asks for this token (<span className="io-mono">Enrol token:</span>). Paste it there; it isn't shown or stored in the shell history.</span>
              <CodeBlock code={created.token} language="text" title="Enrol token" wrap copyLabel="Copy enrol token" />
            </Stack>
            <Stack gap="8">
              <span>Already have <span className="io-mono">gss-agent</span> on the machine? Enrol it by hand, paste the token when it waits for input, then start it with <span className="io-mono">sudo systemctl enable --now gss-agent</span>:</span>
              <CodeBlock code={created.command} language="bash" title="Enrol only" wrap copyLabel="Copy enrol command" />
            </Stack>
            <span className="io-text-muted">
              Expires {formatDateTime(created.enrolToken.expiresAt)} and works once. The host shows up in the list as soon as it connects.
              The token is not shown again.
            </span>
          </Stack>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </Dialog.Footer>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <Dialog.Body>
        <Stack gap="16">
          <Input
            label="Host name"
            description="Optional. The machine's hostname is used when empty."
            value={name}
            maxLength={LIMITS.HOST_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          <Select label="Valid for" options={EXPIRY_OPTIONS} value={expiresInMinutes} onValueChange={(value) => value !== null && setExpiresInMinutes(value)} />
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.Close>Cancel</Dialog.Close>
        <Button type="submit" variant="primary" icon={Plus} loading={busy}>Create command</Button>
      </Dialog.Footer>
    </form>
  );
}
