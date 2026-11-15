import { Button, Card, CardBody, CardHeader, EmptyState, Stack } from "@ionnet/iontronic/react";
import { GitBranch, Plus } from "@ionnet/iontronic/icons";
import type { RouteMatch } from "@/router/Router.tsx";

interface Props {
  match: RouteMatch;
}

/**
 * `/sources` (SOURCES_MANAGE, M3): `SourceApi.useSources()`. One Card per source: name, kind Badge (builtin/git),
 * URL + branch + path (mono), last sync time and commit (short), "Sync now" (loading while `syncing`), enable Switch,
 * edit / delete (AlertDialog; the panel's 409 explains pinned servers), `lastError` as a bad-tone message, and the
 * games list: active version per game with server count, plus `definitionErrors` per game (warn tone, the old version
 * still active). "Add source" Dialog: name, https URL, branch, subfolder, optional token (password Input, write-only),
 * sync interval.
 */
export default function Sources(props: Props) {
  // TODO(builder): D
  return (
    <Stack gap="16">
      <Card>
        <CardHeader title="Sources" description="Git repositories of game definitions." actions={<Button variant="primary" icon={Plus} disabled>Add source</Button>} />
        <CardBody>
          <EmptyState icon={GitBranch} title="Loading sources…" />
        </CardBody>
      </Card>
    </Stack>
  );
}
