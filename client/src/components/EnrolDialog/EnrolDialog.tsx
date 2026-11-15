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
        description="Add a machine that runs gss-agent. The command below works once and expires."
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
    return (
      <>
        <Dialog.Body>
          <Stack gap="16">
            <Stack gap="8">
              <span>On the machine, install <span className="io-mono">gss-agent</span> and make sure Docker is running. Then run:</span>
              <CodeBlock code={created.command} language="bash" title="Enrol" wrap copyLabel="Copy enrol command" />
            </Stack>
            <span className="io-text-muted">
              Expires {formatDateTime(created.enrolToken.expiresAt)}. Once it is enrolled, start the agent with{" "}
              <span className="io-mono">sudo systemctl enable --now gss-agent</span>. The host shows up in the list as soon as it connects.
              This command is not shown again.
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
