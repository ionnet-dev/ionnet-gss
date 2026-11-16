import { useEffect, useRef, useState } from "react";
import { Avatar, Badge, Button, Checkbox, Dialog, EmptyState, Icon, Input, SegmentedControl, Spinner, Stack } from "@ionnet/iontronic/react";
import { ChevronDown, ChevronRight, Download, ExternalLink, Search, TriangleAlert } from "@ionnet/iontronic/icons";
import type { ModCatalogDto, ModFolderDto, ModSearchHitDto, ModVersionDto } from "@shared/api/mods.ts";
import type { ModCatalogProvider } from "@shared/protocol/protocol.gen.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import { ModApi } from "@/Api/ModApi.ts";
import { formatAgo, formatBytes } from "@/components/Format/format.ts";
import LoadError from "@/components/LoadError/LoadError.tsx";
import { useNotify } from "@/components/Notify/useNotify.ts";
import { Link } from "@/router/Router.tsx";
import { useAuth } from "@/hooks/useAuth.ts";
import { describeInstall } from "./modFiles.ts";

export interface ModBrowserProps {
  serverId: string;
  folder: ModFolderDto;
  catalogs: ModCatalogDto[];
  /**
   * The installed game version the catalog filters by; null when unknown.
   */
  version: string | null;
  open: boolean;
  onClose: () => void;
  /**
   * Something was installed: the folder's list is stale.
   */
  onInstalled: () => void;
}

interface Failure {
  status: number;
  error: Error;
}

interface VersionsState {
  loading: boolean;
  error: string | null;
  items: ModVersionDto[] | null;
}

const PAGE_SIZE = 20;
const SEARCH_DELAY = 300; // ms

function compact(count: number): string {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(count);
}

/**
 * The catalog dialog of a mod folder: a switch between the folder's catalogs (opening on the first available one), then
 * per catalog a debounced search (popular mods while empty), a per-mod version list, and install with or without the
 * required dependencies. An unavailable catalog shows why instead of a search.
 */
export default function ModBrowser(props: ModBrowserProps) {
  const { serverId, folder, catalogs, version, open, onClose, onInstalled } = props;
  const [provider, setProvider] = useState<ModCatalogProvider>(() => (catalogs.find((entry) => entry.available) ?? catalogs[0]).provider);
  const [dependencies, setDependencies] = useState(true);
  const [busy, setBusy] = useState(false);
  const catalog = catalogs.find((entry) => entry.provider === provider) ?? catalogs[0];

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && !busy && onClose()}>
      <Dialog.Content
        size="lg"
        title={catalogs.length === 1 ? `Browse ${catalog.label}` : "Browse mods"}
        description={`${folder.label} for ${catalog.loaders.length > 0 ? catalog.loaders.join(", ") : "this game"}${version ? `, game version ${version}` : ""}. Changes apply the next time the server starts.`}
      >
        <Dialog.Body>
          <Stack gap="12">
            {catalogs.length > 1 && (
              <SegmentedControl<ModCatalogProvider>
                aria-label="Catalog"
                value={provider}
                disabled={busy}
                onValueChange={setProvider}
                options={catalogs.map((entry) => ({ value: entry.provider, label: entry.label, icon: entry.available ? undefined : TriangleAlert }))}
              />
            )}
            {catalog.available
              ? (
                <CatalogSearch
                  key={catalog.provider}
                  serverId={serverId}
                  folder={folder}
                  catalog={catalog}
                  open={open}
                  dependencies={dependencies}
                  onBusyChange={setBusy}
                  onInstalled={onInstalled}
                />
              )
              : <Unavailable catalog={catalog} />}
          </Stack>
        </Dialog.Body>
        <Dialog.Footer>
          <Checkbox label="Also install required dependencies" checked={dependencies} disabled={busy} onCheckedChange={setDependencies} />
          <Dialog.Close disabled={busy}>Close</Dialog.Close>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Why a catalog can't be used, with a way to fix it for administrators.
 */
function Unavailable(props: { catalog: ModCatalogDto }) {
  const { catalog } = props;
  const auth = useAuth();
  return (
    <EmptyState
      size="sm"
      icon={TriangleAlert}
      tone="warn"
      title={`${catalog.label} isn't available`}
      description={catalog.unavailableReason ?? `The panel can't use ${catalog.label} right now.`}
      actions={auth.user?.isAdmin ? <Link className="mod-manager__link" to="/settings">Open Settings → Mod catalogs</Link> : undefined}
    />
  );
}

interface CatalogSearchProps {
  serverId: string;
  folder: ModFolderDto;
  catalog: ModCatalogDto;
  open: boolean;
  dependencies: boolean;
  onBusyChange: (busy: boolean) => void;
  onInstalled: () => void;
}

function CatalogSearch(props: CatalogSearchProps) {
  const { serverId, folder, catalog, open, dependencies, onBusyChange, onInstalled } = props;
  const notify = useNotify();
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<ModSearchHitDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Record<string, VersionsState>>({});
  const sequence = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [query]);

  const search = async (offset: number) => {
    const call = ++sequence.current;
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    try {
      const response = await ModApi.search(serverId, folder.key, catalog.provider, term, offset, PAGE_SIZE);
      if (call !== sequence.current) return;
      setHits((current) => (offset === 0 ? response.hits : [...current, ...response.hits]));
      setTotal(response.total);
      setFailure(null);
    } catch (error) {
      if (call !== sequence.current) return;
      setFailure({ status: error instanceof ApiError ? error.status : 0, error: error instanceof Error ? error : new Error(String(error)) });
    }
    finally {
      if (call === sequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  // Search again when the dialog opens (the installed flags may have changed) and when the term settles.
  useEffect(() => {
    if (open) search(0);
  }, [open, term, serverId, folder.key]);

  const toggleVersions = async (hit: ModSearchHitDto) => {
    const id = hit.projectId;
    const isOpen = expanded.has(id);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (isOpen || versions[id]?.items) return;
    setVersions((current) => ({ ...current, [id]: { loading: true, error: null, items: null } }));
    try {
      const items = await ModApi.versions(serverId, folder.key, catalog.provider, id);
      setVersions((current) => ({ ...current, [id]: { loading: false, error: null, items } }));
    } catch (error) {
      setVersions((current) => ({ ...current, [id]: { loading: false, error: error instanceof Error ? error.message : String(error), items: null } }));
    }
  };

  const install = async (hit: ModSearchHitDto, versionId: string | null) => {
    setInstalling(`${hit.projectId}:${versionId ?? ""}`);
    try {
      const response = await ModApi.install(serverId, folder.key, catalog.provider, hit.projectId, versionId, dependencies);
      notify.ok(`${hit.title} installed`, describeInstall(response));
      setHits((current) => current.map((entry) => (entry.projectId === hit.projectId ? { ...entry, installed: true } : entry)));
      onInstalled();
    } catch (error) {
      notify.error(error, `Couldn't install ${hit.title}`);
    }
    finally {
      setInstalling(null);
    }
  };

  const busy = installing !== null;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy]);

  return (
    <Stack gap="12">
      <Input
        aria-label={`Search ${catalog.label}`}
        leading={<Icon icon={Search} />}
        placeholder={`Search ${catalog.label}, or leave empty for the popular ones`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && query !== "") { event.stopPropagation(); setQuery(""); } }}
      />
      {failure && failure.status === 409
        ? <EmptyState size="sm" icon={TriangleAlert} tone="warn" title="Can't search yet" description={failure.error.message} />
        : failure && hits.length === 0
        ? <LoadError title={`Couldn't search ${catalog.label}`} error={failure.error} onRetry={() => search(0)} />
        : loading && hits.length === 0
        ? <Stack direction="row" gap="8" align="center" role="status"><Spinner /><span className="io-text-muted">Searching…</span></Stack>
        : hits.length === 0
        ? <EmptyState size="sm" icon={Search} title="Nothing found" description="Try another name. Only mods that run on a server and fit this game version are listed." />
        : (
          <div className="mod-browser__results" aria-busy={loading}>
            {hits.map((hit) => (
              <HitRow
                key={hit.projectId}
                hit={hit}
                busy={busy}
                installing={installing}
                expanded={expanded.has(hit.projectId)}
                versions={versions[hit.projectId]}
                providerName={catalog.label}
                onToggle={() => toggleVersions(hit)}
                onInstall={(versionId) => install(hit, versionId)}
              />
            ))}
            {failure && <span className="mod-manager__warning" role="alert">Couldn't load more: {failure.error.message}</span>}
            {hits.length < total && (
              <div>
                <Button size="sm" loading={loadingMore} disabled={busy} onClick={() => search(hits.length)}>Load more</Button>
              </div>
            )}
          </div>
        )}
    </Stack>
  );
}

interface HitRowProps {
  hit: ModSearchHitDto;
  busy: boolean;
  installing: string | null;
  expanded: boolean;
  versions?: VersionsState;
  providerName: string;
  onToggle: () => void;
  onInstall: (versionId: string | null) => void;
}

function HitRow(props: HitRowProps) {
  const { hit, busy, installing, expanded, versions, providerName, onToggle, onInstall } = props;
  return (
    <div className="mod-browser__hit">
      <div className="mod-browser__head">
        <Avatar size="md" src={hit.iconUrl ?? undefined} name={hit.title} />
        <div className="mod-browser__text">
          <div className="mod-browser__title">
            <span className="mod-browser__name">{hit.title}</span>
            <span className="io-text-muted">by {hit.author}</span>
            <span className="io-text-muted mod-browser__downloads" title={`${hit.downloads.toLocaleString("en")} downloads`}><Icon icon={Download} size="sm" />{compact(hit.downloads)}</span>
            {hit.installed && <Badge size="sm" tone="ok">Installed</Badge>}
          </div>
          <span className="io-text-muted mod-browser__description">{hit.description}</span>
          {!hit.downloadable && !hit.installed && <span className="io-text-muted">The author only allows downloads from {providerName}. Download the file there and drop it into this folder.</span>}
        </div>
        <div className="mod-browser__actions">
          {hit.downloadable && <Button size="sm" variant="ghost" icon={expanded ? ChevronDown : ChevronRight} aria-expanded={expanded} onClick={onToggle}>Versions</Button>}
          {!hit.installed && hit.downloadable && (
            <Button size="sm" variant="primary" icon={Download} loading={installing === `${hit.projectId}:`} disabled={busy} onClick={() => onInstall(null)}>Install</Button>
          )}
          {!hit.installed && !hit.downloadable && (
            <a className="mod-manager__link" href={hit.pageUrl} target="_blank" rel="noopener noreferrer">Download on {providerName} <Icon icon={ExternalLink} size="sm" /></a>
          )}
        </div>
      </div>
      {expanded && (
        <div className="mod-browser__versions">
          {(!versions || versions.loading) && <Stack direction="row" gap="8" align="center" role="status"><Spinner size="sm" /><span className="io-text-muted">Loading versions…</span></Stack>}
          {versions?.error && <span className="mod-manager__warning" role="alert">{versions.error}</span>}
          {versions?.items?.length === 0 && <span className="io-text-muted">No compatible version.</span>}
          {versions?.items?.map((entry) => {
            const required = entry.dependencies.filter((dependency) => dependency.type === "required").map((dependency) => dependency.title ?? dependency.projectId ?? "an unknown mod");
            return (
              <div key={entry.versionId} className="mod-browser__version">
                <div className="mod-browser__text">
                  <div className="mod-browser__title">
                    <span className="io-mono">{entry.versionNumber}</span>
                    <span className="io-text-muted">{entry.name !== entry.versionNumber ? entry.name : ""}</span>
                  </div>
                  <span className="io-text-muted">
                    {formatAgo(entry.publishedAt)} · {formatBytes(entry.size)} · <span className="io-mono">{entry.fileName}</span>
                  </span>
                  {required.length > 0 && <span className="io-text-muted">Requires {required.join(", ")}</span>}
                </div>
                <Button size="sm" loading={installing === `${hit.projectId}:${entry.versionId}`} disabled={busy} onClick={() => onInstall(entry.versionId)}>
                  {hit.installed ? "Install this version" : "Install"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
