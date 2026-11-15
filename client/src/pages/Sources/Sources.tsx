import { type ReactNode, useState } from "react";
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  Grid,
  IconTile,
  List,
  ListItem,
  Spinner,
  Stack,
  Switch,
} from "@ionnet/iontronic/react";
import { Gamepad2, GitBranch, HardDrive, Pencil, Plus, RefreshCw, Trash2, TriangleAlert } from "@ionnet/iontronic/icons";
import type { SourceDefinitionDto, SourceDto } from "@shared/api/sources.ts";
import { SourceApi } from "@/Api/SourceApi.ts";
import { formatAgo, formatCommit } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import PageHeader from "@/components/PageHeader/PageHeader.tsx";
import type { RouteMatch } from "@/router/Router.tsx";
import SourceDialog from "./SourceDialog.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/sources` (SOURCES_MANAGE): the git repositories game definitions come from, plus the built-in one (shown, not
 * editable). Each source shows its last sync and the problems it found, per game, where they happened. `source.updated`
 * events refetch the list, so a running sync shows up here without a reload.
 */
export default function Sources(_props: Props) {
  const sources = SourceApi.useSources();
  const [editing, setEditing] = useState<SourceDto | "new" | null>(null);
  const [deleting, setDeleting] = useState<SourceDto | null>(null);

  const addButton = <Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>Add source</Button>;

  return (
    <Stack gap="16">
      <PageHeader title="Sources" description="Where game definitions come from. Add a git repository to offer more games." actions={addButton} />
      {sources.data === null && sources.loading && <Card><CardBody><Stack align="center"><Spinner label="Loading sources" /></Stack></CardBody></Card>}
      {sources.data === null && sources.error && (
        <Card><CardBody><LoadError title="Couldn't load the sources" error={sources.error} onRetry={sources.reload} /></CardBody></Card>
      )}
      {sources.data?.length === 0 && (
        <Card>
          <CardBody>
            <EmptyState icon={GitBranch} title="No sources yet" description="Add a git repository that holds game folders, and its games appear when creating a server." actions={addButton} />
          </CardBody>
        </Card>
      )}
      {sources.data?.map((source) => (
        <SourceCard key={source.id} source={source} onChanged={sources.reload} onEdit={() => setEditing(source)} onDelete={() => setDeleting(source)} />
      ))}
      {editing && (
        <SourceDialog source={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={sources.reload} />
      )}
      <DeleteDialog source={deleting} onClose={() => setDeleting(null)} onDeleted={sources.reload} />
    </Stack>
  );
}

interface SourceCardProps {
  source: SourceDto;
  onChanged: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
}

function SourceCard(props: SourceCardProps) {
  const { source, onChanged, onEdit, onDelete } = props;
  const notify = useNotify();
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const builtin = source.kind === "local";
  const state = sourceState(source);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await SourceApi.sync(source.id);
      const failed = Object.keys(result.failed).length;
      const found = result.synced.length === 1 ? "1 game" : `${result.synced.length} games`;
      notify.ok(`${source.name} synced`, failed > 0 ? `${found} ready, ${failed} with errors. See the list below.` : `${found} ready.`);
    } catch (error) {
      notify.error(error, `Couldn't sync ${source.name}`);
    } finally {
      await onChanged();
      setSyncing(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await SourceApi.update(source.id, { enabled });
      await onChanged();
    } catch (error) {
      notify.error(error, `Couldn't ${enabled ? "enable" : "disable"} ${source.name}`);
    } finally {
      setToggling(false);
    }
  };

  const games = gameRows(source);

  return (
    <Card urgent={source.lastError !== null}>
      <CardHeader
        leading={<IconTile icon={builtin ? HardDrive : GitBranch} tone={state.tone} />}
        title={
          <Stack direction="row" gap="8" align="center" wrap>
            <span>{source.name}</span>
            <Badge size="sm" tone="neutral">{builtin ? "Built in" : "Git"}</Badge>
            <Badge size="sm" tone={state.tone}>{state.label}</Badge>
          </Stack>
        }
        description={<span className="io-mono" style={{ wordBreak: "break-all" }}>{source.url}</span>}
      />
      <CardBody>
        <Stack gap="16">
          {source.lastError && (
            <Problem title="The last sync failed">{source.lastError}</Problem>
          )}
          <Grid minChildWidth="11rem" gap="16">
            {!builtin && <Fact label="Branch"><span className="io-mono">{source.branch}</span></Fact>}
            {!builtin && <Fact label="Folder">{source.path === "" ? <span className="io-text-muted">Top of the repository</span> : <span className="io-mono">{source.path}</span>}</Fact>}
            <Fact label="Last sync">
              {source.lastSyncAt
                ? <>{formatAgo(source.lastSyncAt)}{source.kind === "git" && source.lastCommit && <> · <span className="io-mono">{formatCommit(source.lastCommit)}</span></>}</>
                : <span className="io-text-muted">Never</span>}
            </Fact>
            <Fact label="Games">{source.definitions.length === 1 ? "1 game" : `${source.definitions.length} games`}</Fact>
            {!builtin && <Fact label="Syncs">{source.syncIntervalMin ? `Every ${source.syncIntervalMin} min` : "At the panel's default interval"}</Fact>}
            {source.hasToken && <Fact label="Access token"><Badge size="sm" tone="ok">Token set</Badge></Fact>}
          </Grid>
          {games.length > 0 && (
            <List aria-label={`Games from ${source.name}`}>
              {games.map((game) => <GameRow key={game.gameId} game={game} />)}
            </List>
          )}
        </Stack>
      </CardBody>
      <CardFooter>
        <Button icon={RefreshCw} loading={syncing || source.syncing} onClick={sync}>Sync now</Button>
        {!builtin && <Button variant="ghost" icon={Pencil} onClick={onEdit}>Edit</Button>}
        {!builtin && <Button variant="ghost" icon={Trash2} onClick={onDelete}>Delete</Button>}
        <Switch label="Enabled" checked={source.enabled} onCheckedChange={toggle} disabled={toggling} />
      </CardFooter>
    </Card>
  );
}

interface GameRowData {
  gameId: string;
  definition: SourceDefinitionDto | null; // The active version; null = the game never loaded.
  error: string | null;
}

/**
 * Every game the source has: the active ones, and the ones whose last sync failed (even if they never loaded).
 */
function gameRows(source: SourceDto): GameRowData[] {
  const rows: GameRowData[] = source.definitions.map((definition) => ({
    gameId: definition.gameId,
    definition,
    error: source.definitionErrors[definition.gameId] ?? null,
  }));
  for (const [gameId, error] of Object.entries(source.definitionErrors)) {
    if (!rows.some((row) => row.gameId === gameId)) rows.push({ gameId, definition: null, error });
  }
  return rows.sort((a, b) => Number(b.error !== null) - Number(a.error !== null) || a.gameId.localeCompare(b.gameId));
}

function GameRow(props: { game: GameRowData }) {
  const { game } = props;
  const { definition, error } = game;
  const servers = definition?.serverCount ?? 0;
  return (
    <ListItem
      dense
      icon={Gamepad2}
      tone={error ? (definition ? "warn" : "bad") : "neutral"}
      title={definition?.name ?? game.gameId}
      badges={error
        ? <Badge size="sm" tone={definition ? "warn" : "bad"}>{definition ? "Newer version has errors" : "Has errors"}</Badge>
        : undefined}
      description={error
        ? (
          <Stack gap="4">
            <span>{definition ? "The last sync found a problem, so the previous version is still in use:" : "This game couldn't be loaded:"}</span>
            <span className="io-mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{error}</span>
          </Stack>
        )
        : <span className="io-mono">{game.gameId}</span>}
      meta={definition ? `${servers === 1 ? "1 server" : `${servers} servers`} use it` : undefined}
      trailing={definition && definition.commit !== "local" ? formatCommit(definition.commit) : undefined}
    />
  );
}

function sourceState(source: SourceDto): { label: string; tone: "ok" | "warn" | "bad" | "info" | "neutral" } {
  const errors = Object.keys(source.definitionErrors).length;
  if (source.syncing) return { label: "Syncing", tone: "info" };
  if (!source.enabled) return { label: "Disabled", tone: "neutral" };
  if (source.lastError) return { label: "Sync failed", tone: "bad" };
  if (errors > 0) return { label: errors === 1 ? "1 game with errors" : `${errors} games with errors`, tone: "warn" };
  if (source.kind === "git" && source.lastSyncAt === null) return { label: "Not synced yet", tone: "neutral" };
  return { label: "OK", tone: "ok" };
}

function Fact(props: { label: string; children: ReactNode }) {
  const { label, children } = props;
  return (
    <Stack gap="4">
      <span className="io-label">{label}</span>
      <span>{children}</span>
    </Stack>
  );
}

function Problem(props: { title: string; children: ReactNode }) {
  const { title, children } = props;
  return (
    <Stack direction="row" gap="8" align="start" role="alert">
      <TriangleAlert size={20} aria-hidden="true" style={{ flex: "none", color: "var(--io-color-hue-text-bad)" }} />
      <Stack gap="4">
        <strong>{title}</strong>
        <span className="io-text-muted io-mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{children}</span>
      </Stack>
    </Stack>
  );
}

function DeleteDialog(props: { source: SourceDto | null; onClose: () => void; onDeleted: () => Promise<void> }) {
  const { source, onClose, onDeleted } = props;
  const notify = useNotify();

  const remove = async () => {
    if (!source) return;
    try {
      await SourceApi.remove(source.id);
      await onDeleted();
      notify.ok(`${source.name} deleted`);
    } catch (error) {
      notify.error(error, `Couldn't delete ${source.name}`);
    }
  };

  return (
    <AlertDialog.Root open={source !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Content
        title={`Delete ${source?.name ?? "this source"}?`}
        description="Its games disappear from the list of games to create. A source whose games servers still use can't be deleted."
      >
        <AlertDialog.Footer>
          <AlertDialog.Close>Cancel</AlertDialog.Close>
          <AlertDialog.Close variant="danger" onClick={remove}>Delete source</AlertDialog.Close>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
