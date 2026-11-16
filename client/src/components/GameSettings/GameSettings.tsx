import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Grid, Icon, Input, Select, Spinner, Stack, Switch } from "@ionnet/iontronic/react";
import { Info, RotateCcw, Search } from "@ionnet/iontronic/icons";
import type { GameSettingDto, GameSettingsFileDto, GameSettingsResponse, UpdateGameSettingsBody } from "@shared/api/gameSettings.ts";
import type { GameServerDetailResponse } from "@shared/api/servers.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import { GameSettingsApi } from "@/Api/GameSettingsApi.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import "./GameSettings.scss";

export interface GameSettingsProps {
  server: GameServerDetailResponse;
}

/**
 * What the user typed, as file text, by file and key. Only keys that differ from what the file (or the default) holds.
 */
type Edits = Record<string, Record<string, string>>;

/**
 * The Game settings tab: the keys of the game's config files (`server.properties`…) as inputs, read from and written
 * to the real file. Changes apply at the game's next start.
 */
export default function GameSettings(props: GameSettingsProps) {
  const { server } = props;
  const resource = GameSettingsApi.useGameSettings(server.id);
  if (resource.error && !resource.data) return <LoadError title="Couldn't load the game settings" error={resource.error} onRetry={resource.reload} />;
  if (!resource.data) {
    return (
      <Stack direction="row" gap="8" align="center" role="status">
        <Spinner />
        <span className="io-text-muted">Reading the config files…</span>
      </Stack>
    );
  }
  return <SettingsForm server={server} data={resource.data} reload={resource.reload} />;
}

/**
 * The edits that still differ from the freshly read files, for keys that still have a field.
 */
function stillChanged(edits: Edits, data: GameSettingsResponse): Edits {
  const kept: Edits = {};
  for (const [file, values] of Object.entries(edits)) {
    const fields = data.files.find((entry) => entry.file === file)?.groups.flatMap((group) => group.fields) ?? [];
    for (const [key, value] of Object.entries(values)) {
      const field = fields.find((entry) => entry.key === key);
      if (!field || (field.value ?? field.default) === value) continue;
      (kept[file] ??= {})[key] = value;
    }
  }
  return kept;
}

interface SettingsFormProps {
  server: GameServerDetailResponse;
  data: GameSettingsResponse;
  reload: () => Promise<void>;
}

function SettingsForm(props: SettingsFormProps) {
  const { server, data, reload } = props;
  const notify = useNotify();
  const [edits, setEdits] = useState<Edits>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"save" | "restart" | null>(null);

  const keepEdits = useRef(false);

  // Start from the files again whenever they are read (after a save or a retry). After a conflict the edits stay,
  // except those the fresh file no longer has a field for or already holds.
  useEffect(() => {
    if (keepEdits.current) {
      keepEdits.current = false;
      setEdits((current) => stillChanged(current, data));
    }
    else setEdits({});
    setErrors({});
  }, [data]);

  const changedCount = Object.values(edits).reduce((sum, values) => sum + Object.keys(values).length, 0);
  const canRestart = server.state === "running" && server.host.online;
  const needle = query.trim().toLowerCase();

  const setValue = (file: GameSettingsFileDto, field: GameSettingDto, value: string) => {
    setEdits((current) => {
      const values = { ...current[file.file] };
      if (value === baseline(field)) delete values[field.key];
      else values[field.key] = value;
      const next = { ...current, [file.file]: values };
      if (Object.keys(values).length === 0) delete next[file.file];
      return next;
    });
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== fieldId(file.file, field.key))));
    setFormError(null);
  };

  const save = async (restart: boolean) => {
    const body: UpdateGameSettingsBody = {
      files: data.files.filter((file) => edits[file.file]).map((file) => ({ file: file.file, modifiedAt: file.modifiedAt, values: edits[file.file] })),
    };
    setBusy(restart ? "restart" : "save");
    setFormError(null);
    setErrors({});
    try {
      await GameSettingsApi.update(server.id, body);
    } catch (error) {
      setBusy(null);
      const message = error instanceof Error ? error.message : String(error);
      // 409 is also a host that went offline or a server being deleted; only a stale file is worth reloading for.
      if (error instanceof ApiError && error.status === 409 && /changed since/.test(message)) {
        notify.error(error, "The file changed on the server");
        keepEdits.current = true;
        await reload();
        return;
      }
      const id = errorFieldId(message, data.files, edits);
      if (id) setErrors({ [id]: message });
      else setFormError(message);
      return;
    }
    try {
      if (restart) {
        await ServerApi.restart(server.id);
        notify.ok("Settings saved", "The server is restarting to apply them.");
      }
      else notify.ok("Settings saved", "They apply the next time the server starts.");
    } catch (error) {
      notify.error(error, "Settings saved, but the server didn't restart");
    }
    await reload();
    setBusy(null);
  };

  const matching = (file: GameSettingsFileDto) => file.groups
    .map((group) => ({ ...group, fields: group.fields.filter((field) => matches(field, needle)) }))
    .filter((group) => group.fields.length > 0);
  const visible = data.files.map((file) => ({ file, groups: matching(file) })).filter((entry) => entry.groups.length > 0);

  return (
    <Stack gap="16">
      <Input
        aria-label="Search settings"
        leading={<Icon icon={Search} />}
        placeholder="Search settings by name, key or description"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
      />
      {visible.length === 0 && (
        <EmptyState
          title={needle ? "No setting matches" : "No settings to show"}
          description={needle ? "Try another name or key." : "This game declares no settings that apply to this server."}
        />
      )}
      {visible.map(({ file, groups }) => (
        <Card key={file.file}>
          <CardHeader
            title={file.label}
            description={<>
              <span className="io-mono">{file.file}</span>
              {data.version !== null && <> · Fields for version {data.version}</>}
            </>}
          />
          <CardBody>
            <Stack gap="24">
              {!file.exists && (
                <Stack direction="row" gap="8" align="start" role="note">
                  <Icon icon={Info} size="md" />
                  <span className="io-text-muted">
                    The game creates <span className="io-mono">{file.file}</span> when it first starts. The defaults are shown; saving creates the file with the values you change.
                  </span>
                </Stack>
              )}
              {groups.map((group) => (
                <section key={group.name} className="game-settings__group">
                  <Stack gap="4">
                    <h3 className="game-settings__title">{group.name}</h3>
                    {group.description && <span className="io-text-muted">{group.description}</span>}
                  </Stack>
                  <Grid minChildWidth="18rem" gap="16">
                    {group.fields.map((field) => (
                      <SettingField
                        key={field.key}
                        field={field}
                        value={edits[file.file]?.[field.key] ?? baseline(field)}
                        changed={edits[file.file]?.[field.key] !== undefined}
                        error={errors[fieldId(file.file, field.key)]}
                        disabled={busy !== null}
                        onChange={(value) => setValue(file, field, value)}
                      />
                    ))}
                  </Grid>
                </section>
              ))}
            </Stack>
          </CardBody>
        </Card>
      ))}
      <div className="game-settings__bar">
        <Stack gap="4">
          <FormError>{formError}</FormError>
          <span className="io-text-muted">
            {changedCount === 0 ? "No changes." : `${changedCount} ${changedCount === 1 ? "change" : "changes"}.`} Changes apply the next time the server starts.
          </span>
        </Stack>
        <Stack direction="row" gap="8" wrap>
          <Button icon={RotateCcw} disabled={changedCount === 0 || busy !== null} onClick={() => { setEdits({}); setErrors({}); setFormError(null); }}>Discard</Button>
          {canRestart && (
            <Button disabled={changedCount === 0 || busy !== null} loading={busy === "restart"} onClick={() => save(true)}>Save and restart</Button>
          )}
          <Button variant="primary" disabled={changedCount === 0 || busy !== null} loading={busy === "save"} onClick={() => save(false)}>Save</Button>
        </Stack>
      </div>
    </Stack>
  );
}

interface SettingFieldProps {
  field: GameSettingDto;
  value: string;
  changed: boolean;
  error?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

function SettingField(props: SettingFieldProps) {
  const { field, value, changed, error, disabled, onChange } = props;
  const usesDefault = field.value === null;
  const help = (
    <>
      {field.description}
      {usesDefault && !changed && (
        <span className="game-settings__default">
          {" "}
          <Badge size="sm">Default</Badge>
        </span>
      )}
      {changed && <span className="game-settings__edited"> Edited</span>}
    </>
  );
  const common = { label: field.label, description: help, error, disabled, fieldClassName: "game-settings__field" };
  const mark = changed ? { "data-changed": "" } : {};

  let control;
  if (field.type === "boolean") {
    control = <Switch label={field.label} description={help} checked={value === "true"} onCheckedChange={(checked) => onChange(checked ? "true" : "false")} disabled={disabled} />;
  }
  else if (field.type === "select") {
    const options = field.options ?? [];
    const list = value !== "" && !options.includes(value) ? [value, ...options] : options;
    control = (
      <Select
        {...common}
        options={list.map((option) => ({ value: option, label: displayValue(field, option) }))}
        value={value !== "" ? value : null}
        onValueChange={(next) => onChange(next ?? "")}
        placeholder="Choose one"
      />
    );
  }
  else if (field.type === "number") {
    control = (
      <Input
        {...common}
        type="number"
        inputMode={field.integer ? "numeric" : "decimal"}
        step={field.integer ? 1 : "any"}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        value={value}
        placeholder={usesDefault && field.default !== null ? field.default : undefined}
        onChange={(event) => onChange(event.target.value)}
        trailing={field.unit ? <span className="io-mono io-text-muted">{field.unit}</span> : undefined}
      />
    );
  }
  else {
    control = (
      <Input
        {...common}
        value={value}
        readOnly={value.includes("\n")} // A one-line input would drop the line break; edit such values in the Files tab.
        placeholder={usesDefault && field.default !== null ? field.default : undefined}
        onChange={(event) => onChange(event.target.value)}
        trailing={field.unit ? <span className="io-mono io-text-muted">{field.unit}</span> : undefined}
      />
    );
  }
  return <div className="game-settings__item" {...mark}>{control}{field.type === "boolean" && error && <FormError>{error}</FormError>}</div>;
}

/**
 * What an untouched field holds: the file's value, else the default. Text and numbers stay empty while the file has no
 * value (the default shows as a placeholder, and nothing is written unless it is edited).
 */
function baseline(field: GameSettingDto): string {
  if (field.value !== null) return field.value;
  if (field.type === "boolean") return field.default ?? "false";
  if (field.type === "select") return field.default ?? "";
  return "";
}

function displayValue(field: GameSettingDto, value: string): string {
  return field.labels?.[value] ?? value;
}

function matches(field: GameSettingDto, needle: string): boolean {
  if (needle === "") return true;
  return [field.label, field.key, field.description ?? ""].some((text) => text.toLowerCase().includes(needle));
}

function fieldId(file: string, key: string): string {
  return `${file}\u0000${key}`;
}

/**
 * Pin a panel message naming a field as `"Label" (key)` to the edited field with that key; null when it names none.
 */
function errorFieldId(message: string, files: GameSettingsFileDto[], edits: Edits): string | null {
  const keys = [...message.matchAll(/\(([^()\s]+)\)/g)].map((match) => match[1]);
  for (const key of keys) {
    const file = files.find((entry) => edits[entry.file]?.[key] !== undefined);
    if (file) return fieldId(file.file, key);
  }
  return null;
}
