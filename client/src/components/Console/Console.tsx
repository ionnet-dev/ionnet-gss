import { type FormEvent, type KeyboardEvent, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Input } from "@ionnet/iontronic/react";
import { ArrowDown, ArrowUp, Send } from "@ionnet/iontronic/icons";
import type { ConsoleLine } from "@shared/protocol/protocol.gen.ts";
import { ServerApi } from "@/Api/ServerApi.ts";
import { useNotify } from "@/components/Notify/useNotify.ts";
import { useController } from "@/hooks/useController.ts";
import { liveSocket } from "@/live/LiveSocket.ts";
import { type AnsiSegment, parseAnsi } from "./ansi.ts";
import "./Console.scss";

export interface ConsoleProps {
  serverId: string;
  /**
   * Show the input line (running or starting).
   */
  canSend: boolean;
}

const MAX_LINES = 2000;
const MAX_HISTORY = 100;
const STICK_THRESHOLD_PX = 24; // Within this distance of the bottom the log keeps following new lines.

interface Entry {
  id: number; // Local and unique: `seq` restarts when the game process does.
  line: ConsoleLine;
  segments: AnsiSegment[];
}

/**
 * Live console for one server. Subscribes to `server:<id>`; once the panel confirms, fetches the backlog and merges
 * live lines by `seq` (lines at or below the last seen one are dropped, unless they are newer: a new gss-init
 * numbers from 1 again). It keeps the last 2000 lines, loads older pages on request, follows the newest unless the
 * user scrolled up, and sends input with ↑/↓ history.
 */
export default function Console(props: ConsoleProps) {
  const { serverId, canSend } = props;
  const entries = useConsoleStream(serverId);
  const socket = useController(liveSocket);
  const { lines, subscribed, refusal, more, loadingOlder, loadOlder } = entries;

  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [paused, setPaused] = useState(false);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && stickRef.current) log.scrollTop = log.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const log = logRef.current;
    if (!log) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_THRESHOLD_PX;
    stickRef.current = atBottom;
    setPaused(!atBottom);
  };

  const jumpToLatest = () => {
    const log = logRef.current;
    if (!log) return;
    stickRef.current = true;
    setPaused(false);
    log.scrollTop = log.scrollHeight;
  };

  let status = "Connecting…";
  if (refusal) status = `Can't show the console: ${refusal}`;
  else if (socket.status !== "open") status = "Reconnecting…";
  else if (subscribed) status = "Live";

  return (
    <div className="console">
      <div className="console__status" role="status">
        <span className="console__dot" data-live={subscribed && socket.status === "open" ? "" : undefined} />
        {status}
      </div>
      <div className="console__frame">
        <div className="console__log" ref={logRef} onScroll={onScroll} role="log" aria-label="Server console" tabIndex={0}>
          {more && (
            <div className="console__older">
              <Button size="sm" variant="ghost" icon={ArrowUp} loading={loadingOlder} onClick={() => {
                stickRef.current = false;
                loadOlder();
              }}>
                Load older lines
              </Button>
            </div>
          )}
          {lines.length === 0 && <div className="console__empty">{subscribed ? "No output yet." : "Loading the console…"}</div>}
          {lines.map((entry) => <LineRow key={entry.id} entry={entry} />)}
        </div>
        {paused && (
          <Button className="console__jump" size="sm" variant="primary" icon={ArrowDown} onClick={jumpToLatest}>
            Jump to latest
          </Button>
        )}
      </div>
      <CommandInput serverId={serverId} canSend={canSend} onSent={jumpToLatest} />
    </div>
  );
}

const LineRow = memo(function LineRow(props: { entry: Entry }) {
  const { entry } = props;
  return (
    <div className="console__line" data-stream={entry.line.stream}>
      {entry.segments.map((segment, index) => (
        <span
          key={index}
          data-fg={segment.fg ?? undefined}
          data-bg={segment.bg ?? undefined}
          data-bold={segment.bold || undefined}
          data-dim={segment.dim || undefined}
          data-italic={segment.italic || undefined}
          data-underline={segment.underline || undefined}
        >
          {segment.text}
        </span>
      ))}
    </div>
  );
});

function CommandInput(props: { serverId: string; canSend: boolean; onSent: () => void }) {
  const { serverId, canSend, onSent } = props;
  const notify = useNotify();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const cursor = useRef(-1); // -1 = not browsing history.
  const draft = useRef("");

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const line = text.trim();
    if (!line || !canSend || busy) return;
    setBusy(true);
    try {
      await ServerApi.sendInput(serverId, line);
      history.current = [line, ...history.current.filter((entry) => entry !== line)].slice(0, MAX_HISTORY);
      cursor.current = -1;
      setText("");
      onSent();
    } catch (error) {
      notify.error(error, "Couldn't send the command");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const past = history.current;
    if (event.key === "ArrowUp" && cursor.current < past.length - 1) {
      if (cursor.current === -1) draft.current = text;
      cursor.current++;
      setText(past[cursor.current]);
    }
    else if (event.key === "ArrowDown" && cursor.current >= 0) {
      cursor.current--;
      setText(cursor.current === -1 ? draft.current : past[cursor.current]);
    }
    else return;
    event.preventDefault();
  };

  return (
    <form className="console__input" onSubmit={submit}>
      <Input
        mono
        aria-label="Console command"
        placeholder={canSend ? "Type a command and press Enter" : "Start the server to send commands"}
        value={text}
        disabled={!canSend}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => {
          cursor.current = -1;
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <Button type="submit" variant="primary" icon={Send} disabled={!canSend || text.trim() === ""} loading={busy}>Send</Button>
    </form>
  );
}

interface ConsoleStream {
  lines: Entry[];
  subscribed: boolean;
  refusal: string | null;
  more: boolean; // Older lines can be loaded.
  loadingOlder: boolean;
  loadOlder: () => void;
}

const BACKLOG_PAGE = 500;

/**
 * Subscribe to the topic, load the backlog once the panel confirms (and again after a reconnect), and merge the live
 * lines by `seq`. Lines that arrive while the backlog is loading wait, then only those newer than the backlog are kept.
 * `seq` belongs to one gss-init process: a line with a lower `seq` but a later time than the newest one shown comes
 * from a new process and restarts the numbering; an older one is a repeat and dropped.
 */
function useConsoleStream(serverId: string): ConsoleStream {
  const [state, setState] = useState<Omit<ConsoleStream, "loadOlder">>({ lines: [], subscribed: false, refusal: null, more: false, loadingOlder: false });
  const olderRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    setState({ lines: [], subscribed: false, refusal: null, more: false, loadingOlder: false });
    let nextId = 0;
    let lastSeq = -1;
    let lastAt = 0;
    let firstSeq = 0; // Oldest line shown, for paging back.
    let loadToken = 0;
    let loaded = false;
    let waiting: ConsoleLine[] = [];
    let disposed = false;

    const toEntries = (lines: ConsoleLine[]): Entry[] =>
      lines.map((line) => ({ id: nextId++, line, segments: parseAnsi(line.text) }));

    const accept = (lines: ConsoleLine[]): Entry[] => {
      const fresh: ConsoleLine[] = [];
      for (const line of lines) {
        const at = Date.parse(line.at) || 0;
        if (line.seq <= lastSeq && at <= lastAt) continue; // Seen already.
        if (line.seq <= lastSeq) firstSeq = line.seq; // A new gss-init: its numbering starts again.
        lastSeq = line.seq;
        lastAt = Math.max(lastAt, at);
        fresh.push(line);
      }
      return toEntries(fresh);
    };

    const append = (lines: ConsoleLine[]) => {
      const fresh = accept(lines);
      if (fresh.length === 0) return;
      setState((current) => ({ ...current, lines: [...current.lines, ...fresh].slice(-MAX_LINES) }));
    };

    const load = async () => {
      const token = ++loadToken;
      loaded = false;
      waiting = [];
      try {
        const backlog = await ServerApi.backlog(serverId, BACKLOG_PAGE);
        if (disposed || token !== loadToken) return;
        lastSeq = -1;
        lastAt = 0;
        firstSeq = backlog.lines[0]?.seq ?? 0;
        const base = accept(backlog.lines);
        const late = accept(waiting);
        waiting = [];
        loaded = true;
        setState((current) => ({ ...current, subscribed: true, refusal: null, more: backlog.more, lines: [...base, ...late].slice(-MAX_LINES) }));
      } catch (error) {
        if (disposed || token !== loadToken) return;
        setState((current) => ({ ...current, refusal: error instanceof Error ? error.message : String(error) }));
      }
    };

    olderRef.current = async () => {
      if (!loaded || firstSeq <= 1) return;
      const token = loadToken;
      setState((current) => ({ ...current, loadingOlder: true }));
      try {
        const page = await ServerApi.backlog(serverId, BACKLOG_PAGE, firstSeq);
        if (disposed || token !== loadToken) return;
        const older = toEntries(page.lines.filter((line) => line.seq < firstSeq));
        firstSeq = page.lines[0]?.seq ?? firstSeq;
        setState((current) => ({ ...current, loadingOlder: false, more: page.more, lines: [...older, ...current.lines] }));
      } catch (error) {
        if (disposed || token !== loadToken) return;
        setState((current) => ({ ...current, loadingOlder: false, refusal: error instanceof Error ? error.message : String(error) }));
      }
    };

    const offConsole = liveSocket.on("server.console", (event) => {
      if (event.serverId !== serverId) return;
      if (loaded) append(event.lines);
      else waiting.push(...event.lines);
    });
    const offTopic = liveSocket.subscribeTopic(`server:${serverId}`, {
      onSubscribed: load,
      onRefused: (message) => setState((current) => ({ ...current, subscribed: false, refusal: message })),
    });

    return () => {
      disposed = true;
      olderRef.current = () => undefined;
      offConsole();
      offTopic();
    };
  }, [serverId]);

  return { ...state, loadOlder: () => olderRef.current() };
}
