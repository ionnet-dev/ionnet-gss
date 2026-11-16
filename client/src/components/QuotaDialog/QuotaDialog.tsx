import { type FormEvent, useEffect, useState } from "react";
import { Button, Dialog, Grid, Input, Separator, Spinner, Stack } from "@ionnet/iontronic/react";
import type { EffectiveQuotaDto, QuotaDto, UpdateQuotaBody, UserDto } from "@shared/api/users.ts";
import { UserApi } from "@/Api/UserApi.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import QuotaUsage from "@/components/QuotaUsage/QuotaUsage.tsx";

interface Props {
  user: UserDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Largest value a quota field takes (the panel's columns are INTEGER).
 */
const MAX_QUOTA_VALUE = 2147483647;

/**
 * Each field of the form. `scale` turns what is typed into the stored unit (CPUs → thousandths).
 */
const FIELDS: { key: keyof QuotaDto; label: string; scale: number }[] = [
  { key: "maxServers", label: "Game servers", scale: 1 },
  { key: "maxMemoryMb", label: "RAM (MB)", scale: 1 },
  { key: "maxCpuMillis", label: "CPUs", scale: 1000 },
  { key: "maxDiskMb", label: "Disk (MB)", scale: 1 },
  { key: "maxBackups", label: "Backups", scale: 1 },
];

type Values = Record<keyof QuotaDto, string>;

/**
 * The form's text for the user's overrides (empty = panel default).
 */
function valuesOf(quota: EffectiveQuotaDto): Values {
  const values = {} as Values;
  for (const field of FIELDS) {
    const value = quota.overrides[field.key];
    values[field.key] = value === null ? "" : `${value / field.scale}`;
  }
  return values;
}

/**
 * The panel default for a field: the effective limit when the user has no override for it.
 */
function defaultOf(quota: EffectiveQuotaDto, key: keyof QuotaDto): number | null {
  return quota.overrides[key] === null ? quota.limits[key] : null;
}

/**
 * Users page: edit one user's quota overrides (`UserApi.useQuota` / `setQuota`). Each field: a number, or empty =
 * panel default (shown as the placeholder); `QuotaUsage compact` above the form. M5, parcel A.
 */
export default function QuotaDialog(props: Props) {
  const { user, open, onOpenChange } = props;
  const quota = UserApi.useQuota(user.id);
  const notify = useNotify();
  const [values, setValues] = useState<Values | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof QuotaDto, string>>>({});
  const [busy, setBusy] = useState(false);

  // Fill the form once per opening; later live refetches update the usage above it, not what is being typed.
  useEffect(() => {
    if (!open) setValues(null);
    else if (quota.data && values === null) setValues(valuesOf(quota.data));
  }, [open, quota.data, values]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!values) return;
    const body: UpdateQuotaBody = {};
    const problems: Partial<Record<keyof QuotaDto, string>> = {};
    for (const field of FIELDS) {
      const text = values[field.key].trim();
      if (text === "") {
        body[field.key] = null;
        continue;
      }
      const value = Math.round(Number(text) * field.scale);
      if (!Number.isFinite(value) || value < 0 || value > MAX_QUOTA_VALUE || (field.scale === 1 && !Number.isInteger(Number(text)))) {
        problems[field.key] = field.scale === 1 ? "A whole number, 0 or more. Leave it empty for the panel default." : "A number of CPUs, 0 or more (0.5 = half a CPU). Leave it empty for the panel default.";
        continue;
      }
      body[field.key] = value;
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      await UserApi.setQuota(user.id, body);
      notify.ok(`Quota saved for ${user.username}`);
      onOpenChange(false);
    } catch (error) {
      notify.error(error, "Couldn't save the quota");
    } finally {
      setBusy(false);
    }
  };

  const data = quota.data;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        title={`Quota for ${user.username}`}
        description="Limits for the servers they own, whoever changes them. Empty fields use the panel default. Lowering a limit below what they use keeps their servers running and only blocks growth."
      >
        <form onSubmit={submit} noValidate>
          <Dialog.Body>
            {data === null && quota.error && <LoadError title="Couldn't load the quota" error={quota.error} onRetry={quota.reload} />}
            {data === null && !quota.error && <Stack align="center"><Spinner label="Loading the quota" /></Stack>}
            {data && values && (
              <Stack gap="16">
                <QuotaUsage quota={data} compact />
                <Separator />
                {data.exempt && <span className="io-text-muted">Administrators have no quota. These values apply if they stop being one.</span>}
                <Grid minChildWidth="12rem" gap="12">
                  {FIELDS.map((field) => {
                    const fallback = defaultOf(data, field.key);
                    return (
                      <Input
                        key={field.key}
                        label={field.label}
                        type="number"
                        inputMode={field.scale === 1 ? "numeric" : "decimal"}
                        min={0}
                        step={field.scale === 1 ? 1 : 0.1}
                        placeholder={fallback === null ? "Panel default" : `Default: ${fallback / field.scale}`}
                        value={values[field.key]}
                        onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                        error={errors[field.key]}
                      />
                    );
                  })}
                </Grid>
              </Stack>
            )}
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>Cancel</Dialog.Close>
            <Button type="submit" variant="primary" loading={busy} disabled={!values}>Save</Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
