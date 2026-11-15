import { Input, Select, Stack, Switch } from "@ionnet/iontronic/react";
import type { DefinitionDto } from "@shared/api/definitions.ts";
import type { ServerVariableDto, VariableValue } from "@shared/api/servers.ts";
import type { VariableType } from "@shared/protocol/protocol.gen.ts";

/**
 * One variable as the form needs it, whether it comes from a definition (create) or a server (settings).
 */
export interface FormVariable {
  key: string;
  label: string;
  description: string | null;
  type: VariableType;
  options: string[] | null;
  unit: string | null;
  min: number | null; // `number` only.
  max: number | null;
  reinstall: boolean;
  defaultValue: VariableValue | null;
  /**
   * `secret` only: the panel generates a value when none is given.
   */
  generate: boolean;
  /**
   * `secret` only: a value is stored already (settings).
   */
  isSet: boolean;
}

/**
 * What the inputs hold: text for everything but booleans, so a half-typed number survives.
 */
export type FormValues = Record<string, string | boolean>;
export type FormErrors = Record<string, string>;

/**
 * Variables of a definition, for the create form.
 */
export function fromDefinition(definition: DefinitionDto): FormVariable[] {
  return definition.variables.map((variable) => ({
    key: variable.key,
    label: variable.label ?? variable.key,
    description: variable.description ?? null,
    type: variable.type,
    options: variable.options ?? null,
    unit: variable.unit ?? null,
    min: variable.min ?? null,
    max: variable.max ?? null,
    reinstall: variable.reinstall ?? false,
    defaultValue: variable.default ?? null,
    generate: variable.generate !== undefined,
    isSet: false,
  }));
}

/**
 * Variables of a server, for the settings form. Their current value is the default the form starts from.
 */
export function fromServer(variables: ServerVariableDto[]): FormVariable[] {
  return variables.map((variable) => ({
    key: variable.key,
    label: variable.label,
    description: variable.description,
    type: variable.type,
    options: variable.options,
    unit: variable.unit,
    min: variable.min,
    max: variable.max,
    reinstall: variable.reinstall,
    defaultValue: variable.type === "secret" ? null : variable.value,
    generate: false,
    isSet: variable.isSet,
  }));
}

/**
 * The values a form starts with: defaults, `false` for a boolean without one, empty text otherwise.
 */
export function initialValues(variables: FormVariable[]): FormValues {
  const values: FormValues = {};
  for (const variable of variables) {
    if (variable.type === "boolean") values[variable.key] = variable.defaultValue === true || variable.defaultValue === "true";
    else if (variable.type === "secret") values[variable.key] = "";
    else values[variable.key] = variable.defaultValue === null ? "" : String(variable.defaultValue);
  }
  return values;
}

function isRequired(variable: FormVariable): boolean {
  return variable.type !== "boolean" && variable.type !== "secret" && variable.defaultValue === null;
}

/**
 * Client-side checks the panel would repeat: required values, numbers and their min/max, select choices.
 */
export function validate(variables: FormVariable[], values: FormValues): FormErrors {
  const errors: FormErrors = {};
  for (const variable of variables) {
    const raw = values[variable.key];
    const text = typeof raw === "string" ? raw.trim() : "";
    if (variable.type === "boolean" || variable.type === "secret") continue;
    if (text === "") {
      if (isRequired(variable)) errors[variable.key] = `${variable.label} is required.`;
    }
    else if (variable.type === "number" && !Number.isFinite(Number(text))) errors[variable.key] = "Enter a number.";
    else if (variable.type === "number" && variable.min !== null && Number(text) < variable.min) errors[variable.key] = `At least ${variable.min}${unitSuffix(variable)}.`;
    else if (variable.type === "number" && variable.max !== null && Number(text) > variable.max) errors[variable.key] = `At most ${variable.max}${unitSuffix(variable)}.`;
    else if (variable.type === "select" && variable.options && !variable.options.includes(text)) errors[variable.key] = "Pick one of the choices.";
  }
  return errors;
}

/**
 * The values to send. Create (`initial` omitted): everything the user filled; empty secrets are left out so the
 * panel generates them. Settings: only what differs from `initial`.
 */
export function toValues(variables: FormVariable[], values: FormValues, initial?: FormValues): Record<string, VariableValue> {
  const result: Record<string, VariableValue> = {};
  for (const variable of variables) {
    const raw = values[variable.key];
    if (initial && raw === initial[variable.key]) continue;
    if (variable.type === "boolean") result[variable.key] = raw === true;
    else if (typeof raw !== "string") continue;
    else if (variable.type === "secret") {
      if (raw !== "") result[variable.key] = raw;
    }
    else if (variable.type === "number") {
      if (raw.trim() !== "") result[variable.key] = Number(raw);
    }
    else if (raw.trim() !== "" || initial) result[variable.key] = raw.trim();
  }
  return result;
}

/**
 * Pin a panel validation message to the variable it names (by key or label), so it shows under that field.
 * Returns null when the message names none.
 */
export function errorFieldFor(message: string, variables: FormVariable[]): string | null {
  const lower = message.toLowerCase();
  for (const variable of variables) {
    if (lower.includes(`"${variable.key.toLowerCase()}"`) || lower.includes(`'${variable.key.toLowerCase()}'`)) return variable.key;
  }
  for (const variable of variables) {
    if (lower.includes(variable.label.toLowerCase())) return variable.key;
  }
  for (const variable of variables) {
    if (new RegExp(`\\b${variable.key.toLowerCase().replace(/[^a-z0-9_]/g, "\\$&")}\\b`).test(lower)) return variable.key;
  }
  return null;
}

export interface VariableFormProps {
  variables: FormVariable[];
  values: FormValues;
  errors?: FormErrors;
  onChange: (key: string, value: string | boolean) => void;
  disabled?: boolean;
  /**
   * Settings: warn on `reinstall` variables and treat secrets as "keep the stored one".
   */
  editing?: boolean;
}

/**
 * Inputs generated from variable declarations: string → text, number → number with its unit, boolean → switch,
 * select → select, secret → password (empty keeps the stored value, or has the panel generate one).
 */
export default function VariableForm(props: VariableFormProps) {
  const { variables, values, errors = {}, onChange, disabled, editing } = props;
  if (variables.length === 0) return <span className="io-text-muted">This game has no settings to fill in.</span>;
  return (
    <Stack gap="16">
      {variables.map((variable) => (
        <VariableField
          key={variable.key}
          variable={variable}
          value={values[variable.key]}
          error={errors[variable.key]}
          onChange={(value) => onChange(variable.key, value)}
          disabled={disabled}
          editing={editing}
        />
      ))}
    </Stack>
  );
}

interface VariableFieldProps {
  variable: FormVariable;
  value: string | boolean | undefined;
  error?: string;
  onChange: (value: string | boolean) => void;
  disabled?: boolean;
  editing?: boolean;
}

function VariableField(props: VariableFieldProps) {
  const { variable, value, error, onChange, disabled, editing } = props;
  const notes = [variable.description];
  if (editing && variable.reinstall) notes.push("Changing this reinstalls the server the next time it starts.");
  if (variable.type === "secret") {
    if (editing) notes.push("Leave empty to keep the current value.");
    else if (variable.generate) notes.push("Leave empty and one is generated for you.");
  }
  const description = notes.filter(Boolean).join(" ") || undefined;
  const common = { label: variable.label, description, error, disabled, required: isRequired(variable) };

  if (variable.type === "boolean") {
    return <Switch label={variable.label} description={description} checked={value === true} onCheckedChange={onChange} disabled={disabled} />;
  }
  if (variable.type === "select") {
    return (
      <Select
        {...common}
        options={(variable.options ?? []).map((option) => ({ value: option, label: option }))}
        value={typeof value === "string" && value !== "" ? value : null}
        onValueChange={(next) => onChange(next ?? "")}
        placeholder="Choose one"
      />
    );
  }
  if (variable.type === "number") {
    return (
      <Input
        {...common}
        type="number"
        inputMode="decimal"
        min={variable.min ?? undefined}
        max={variable.max ?? undefined}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        trailing={variable.unit ? <span className="io-mono io-text-muted">{variable.unit}</span> : undefined}
      />
    );
  }
  if (variable.type === "secret") {
    return (
      <Input
        {...common}
        type="password"
        autoComplete="new-password"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder={editing && variable.isSet ? "Unchanged" : variable.generate ? "Generated for you" : undefined}
      />
    );
  }
  return (
    <Input
      {...common}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      trailing={variable.unit ? <span className="io-mono io-text-muted">{variable.unit}</span> : undefined}
    />
  );
}

function unitSuffix(variable: FormVariable): string {
  return variable.unit ? ` ${variable.unit}` : "";
}
