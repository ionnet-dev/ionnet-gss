import type { GameServerDto } from "@shared/api/servers.ts";

interface Props {
  server: GameServerDto;
}

/**
 * Server page "Sharing" tab (owner level): list of shares with a role select each, remove, and "Share" by username +
 * role (`ShareApi`). For a shared user the server page offers "Leave" instead (not this component). M5, parcel B.
 */
export default function ServerSharing(props: Props) {
  // TODO(builder): M5 sharing
  return null;
}
