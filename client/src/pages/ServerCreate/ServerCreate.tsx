import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, EmptyState, Grid, Icon, Input, Spinner, Stack, Switch } from "@ionnet/iontronic/react";
import { ArrowLeft, Check, Database, Gamepad2, Server } from "@ionnet/iontronic/icons";
import type { DefinitionDto } from "@shared/api/definitions.ts";
import { LIMITS } from "@shared/constants.ts";
import type { HostDto } from "@shared/api/hosts.ts";
import { DefinitionApi } from "@/Api/DefinitionApi.ts";
import { HostApi } from "@/Api/HostApi.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import { formatBytes, formatCommit } from "@/components/Format/format.ts";
import { useNotify } from "@/components/Notify/useNotify.ts";
import FormError from "@/components/FormError/FormError.tsx";
import LoadError from "@/components/LoadError/LoadError.tsx";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import { PRIVATE_NETWORK_DESCRIPTION, PRIVATE_NETWORK_LABEL } from "@/components/ServerSettings/ServerSettings.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import VariableForm, {
  errorFieldFor,
  type FormErrors,
  type FormValues,
  fromDefinition,
  initialValues,
  toValues,
  useVariableOptions,
  validate,
} from "@/components/VariableForm/VariableForm.tsx";
import { navigate, type RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/servers/new` (SERVERS_CREATE): pick an online host, pick a game, then fill in the form generated from the game's
 * variables and name the server. The panel's validation messages show under the field they name.
 */
export default function ServerCreate(_props: Props) {
  const hosts = HostApi.useHosts();
  const definitions = DefinitionApi.useDefinitions();
  const [hostId, setHostId] = useState<string | null>(null);
  const [definitionId, setDefinitionId] = useState<number | null>(null);

  // Only hosts the user may create on (a grant, or SERVERS_MANAGE_ALL) are offered.
  const allowed = useMemo(() => (hosts.data ?? []).filter((host) => host.canCreate), [hosts.data]);
  const usable = useMemo(() => allowed.filter((host) => host.online && !host.disabled), [allowed]);
  const unavailable = allowed.length - usable.length;
  const host = usable.find((candidate) => candidate.id === hostId) ?? null;
  const definition = definitions.data?.find((candidate) => candidate.id === definitionId) ?? null;
  const notify = useNotify();
  const picked = useRef<DefinitionDto | null>(null);

  // A sync can replace the picked game with a newer version while the form is open: follow it, with a heads-up.
  useEffect(() => {
    if (definitionId === null || !definitions.data || definition) return;
    const previous = picked.current;
    const successor = previous && definitions.data.find((candidate) => candidate.gameId === previous.gameId && candidate.source === previous.source);
    if (successor) {
      picked.current = successor;
      setDefinitionId(successor.id);
      notify.ok(`${successor.name} was updated`, "A new version was synced just now, so the form starts again with it.");
    }
    else setDefinitionId(null);
  }, [definitions.data, definitionId, definition]);

  // A single usable host needs no choosing.
  useEffect(() => {
    if (hostId === null && usable.length === 1) setHostId(usable[0].id);
    else if (hostId !== null && !usable.some((candidate) => candidate.id === hostId)) setHostId(null);
  }, [usable, hostId]);

  const back = <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate("/servers")}>Servers</Button>;

  return (
    <Stack gap="16">
      <PageHeader title="New server" description="Choose where it runs and what it plays, then set it up." leading={back} />
      <Step number={1} title="Choose a host" done={host !== null}>
        {hosts.data === null && hosts.loading && <Stack align="center"><Spinner label="Loading hosts" /></Stack>}
        {hosts.data === null && hosts.error && <LoadError title="Couldn't load the hosts" error={hosts.error} onRetry={hosts.reload} />}
        {hosts.data && usable.length === 0 && (
          <EmptyState
            icon={Server}
            title="No host is available"
            description={allowed.length === 0
              ? "There's no host you can use yet. An admin needs to enrol one and give you access to it."
              : "Every host you can use is offline or disabled right now. Try again when one is back."}
          />
        )}
        {usable.length > 0 && (
          <Stack gap="12">
            <Grid minChildWidth="16rem" gap="12" role="radiogroup" aria-label="Host">
              {usable.map((candidate) => (
                <ChoiceCard key={candidate.id} selected={candidate.id === hostId} onSelect={() => setHostId(candidate.id)} title={candidate.name} icon={Server}>
                  {hostFacts(candidate)}
                </ChoiceCard>
              ))}
            </Grid>
            {unavailable > 0 && <span className="io-text-muted">{unavailable === 1 ? "1 more host is" : `${unavailable} more hosts are`} offline or disabled and not shown.</span>}
          </Stack>
        )}
      </Step>
      {host && (
        <Step number={2} title="Choose a game" done={definition !== null}>
          {definitions.data === null && definitions.loading && <Stack align="center"><Spinner label="Loading games" /></Stack>}
          {definitions.data === null && definitions.error && <LoadError title="Couldn't load the games" error={definitions.error} onRetry={definitions.reload} />}
          {definitions.data?.length === 0 && <EmptyState icon={Gamepad2} title="No games available" description="An admin needs to add a game definition first." />}
          {definitions.data && definitions.data.length > 0 && (
            <Grid minChildWidth="16rem" gap="12" role="radiogroup" aria-label="Game">
              {definitions.data.map((candidate) => (
                <ChoiceCard key={candidate.id} selected={candidate.id === definitionId} onSelect={() => { picked.current = candidate; setDefinitionId(candidate.id); }} title={gameTitle(candidate)} icon={Gamepad2}>
                  {gameFacts(candidate)}
                </ChoiceCard>
              ))}
            </Grid>
          )}
        </Step>
      )}
      {host && definition && <Details key={definition.id} host={host} definition={definition} />}
    </Stack>
  );
}

function hostFacts(host: HostDto): string {
  const facts = host.facts;
  const parts: string[] = [];
  if (facts) {
    const memoryBytes = host.capacity.maxMemoryMb ? host.capacity.maxMemoryMb * 1024 * 1024 : facts.memory.totalBytes;
    parts.push(`${formatBytes(memoryBytes)} RAM`, `${facts.cpu.threads} threads`, `${formatBytes(facts.disk.freeBytes)} disk free`);
  }
  parts.push(host.serverCount === 1 ? "1 server" : `${host.serverCount} servers`);
  return parts.join(" · ");
}

function gameTitle(definition: DefinitionDto): ReactNode {
  return (
    <Stack direction="row" gap="8" align="center" wrap>
      <span>{definition.name}</span>
      {definition.isStack && <Badge size="sm" tone="info" icon={Database}>Stack</Badge>}
    </Stack>
  );
}

/**
 * Ports, then where the definition comes from: its source and version.
 */
function gameFacts(definition: DefinitionDto): ReactNode {
  const published = definition.ports.filter((port) => !port.internal);
  const ports = published.length === 0
    ? `${definition.variables.length} settings`
    : `Port ${published.map((port) => `${port.default ?? "auto"}/${port.proto}`).join(", ")}`;
  const source = definition.sourceKind === "local" ? "Built in" : `${definition.source} · ${formatCommit(definition.commit)}`;
  return (
    <>
      <span>{ports}</span>
      <span className="io-mono" style={{ display: "block" }}>{source}</span>
    </>
  );
}

/**
 * What a stack brings along, so the user knows a database comes with the game and what it costs in memory.
 */
function ServicesNote(props: { definition: DefinitionDto }) {
  const { definition } = props;
  if (!definition.isStack) return null;
  const services = definition.services;
  const memoryMb = services.reduce((sum, service) => sum + (service.memoryMb ?? 0), 0);
  return (
    <Stack direction="row" gap="12" align="start" role="note">
      <Icon icon={Database} size="md" />
      <Stack gap="4">
        <strong>{services.length === 1 ? "Comes with an extra container" : "Comes with extra containers"}</strong>
        <ul style={{ margin: 0, paddingLeft: "var(--io-space-16)" }}>
          {services.map((service) => (
            <li key={service.name}>
              <span className="io-mono">{service.name}</span> <span className="io-text-muted">({service.image}{service.memoryMb ? `, up to ${formatBytes(service.memoryMb * 1024 * 1024)} of memory` : ""})</span>
            </li>
          ))}
        </ul>
        <span className="io-text-muted">
          {memoryMb > 0 ? `Together they use up to ${formatBytes(memoryMb * 1024 * 1024)} of memory on top of the game's, which counts against your quota. ` : ""}
          They start before the game and can only be reached from it.
        </span>
      </Stack>
    </Stack>
  );
}

function Step(props: { number: number; title: string; done: boolean; children: ReactNode }) {
  const { number, title, done, children } = props;
  return (
    <Card>
      <CardHeader
        leading={<span className="io-mono io-text-muted" aria-hidden="true">{done ? <Icon icon={Check} size="md" /> : number}</span>}
        title={title}
      />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function ChoiceCard(props: { selected: boolean; onSelect: () => void; title: ReactNode; icon: typeof Server; children: ReactNode }) {
  const { selected, onSelect, title, icon, children } = props;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };
  return (
    <Card interactive selected={selected} role="radio" aria-checked={selected} tabIndex={0} onClick={onSelect} onKeyDown={onKeyDown}>
      <CardHeader leading={<Icon icon={icon} size="lg" />} title={title} description={children} />
    </Card>
  );
}

/**
 * The last step: server name and the generated variable form.
 */
function Details(props: { host: HostDto; definition: DefinitionDto }) {
  const { host, definition } = props;
  const base = useMemo(() => fromDefinition(definition), [definition]);
  const variables = useVariableOptions(definition.id, base);
  const [name, setName] = useState("");
  const [values, setValues] = useState<FormValues>(() => initialValues(base));
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const canAllowPrivateNetwork = useAuth().has("SERVERS_PRIVATE_NETWORK");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validate(variables, values);
    if (!name.trim()) found.name = "Give the server a name.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const created = await ServerApi.create({
        name: name.trim(),
        hostId: host.id,
        definitionId: definition.id,
        variables: toValues(variables, values),
        ...(canAllowPrivateNetwork ? { allowPrivateNetwork } : {}),
      });
      navigate(`/servers/${created.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = errorFieldFor(message, variables);
      if (key) setErrors({ [key]: message });
      else if (/name/i.test(message) && !/hostname/i.test(message)) setErrors({ name: message });
      else setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader leading={<span className="io-mono io-text-muted" aria-hidden="true">3</span>} title="Set it up" description={`${definition.name}${definition.sourceKind === "git" ? ` (${definition.source} · ${formatCommit(definition.commit)})` : ""} on ${host.name}`} />
      <form onSubmit={submit} noValidate>
        <CardBody>
          <Stack gap="24">
            <Input
              label="Server name"
              description="Shown in your server list. You can rename it later."
              required
              value={name}
              maxLength={LIMITS.SERVER_NAME_MAX}
              placeholder="My server"
              onChange={(event) => setName(event.target.value)}
              error={errors.name}
            />
            <VariableForm
              variables={variables}
              values={values}
              errors={errors}
              disabled={busy}
              onChange={(key, value) => {
                setValues((current) => ({ ...current, [key]: value }));
                setErrors((current) => (key in current ? Object.fromEntries(Object.entries(current).filter(([field]) => field !== key)) : current));
              }}
            />
            <ServicesNote definition={definition} />
            {canAllowPrivateNetwork && (
              <Switch label={PRIVATE_NETWORK_LABEL} description={PRIVATE_NETWORK_DESCRIPTION} checked={allowPrivateNetwork} onCheckedChange={setAllowPrivateNetwork} disabled={busy} />
            )}
            <FormError>{formError}</FormError>
          </Stack>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" loading={busy}>Create server</Button>
          <Button type="button" variant="ghost" onClick={() => navigate("/servers")}>Cancel</Button>
        </CardFooter>
      </form>
    </Card>
  );
}
