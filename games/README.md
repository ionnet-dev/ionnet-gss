# Starter definitions

One folder per game: `<id>/game.yml` plus any files it references (`hooks/*.sh`, config templates). The panel loads
this folder as the built-in `builtin` source at startup (`GAMES_DIR`); git sources (M3) use the same layout.
Format: `protocol/schema/definition.json` and the blueprint's "A game definition" section.

- Hooks run inside the container as uid 1000 in `/data`, with `GSS_VAR_<KEY>`, `GSS_PORT_<NAME>` and `GSS_SERVER_ID`
  in the environment. Non-zero exit = the step failed.
- M2 supports install steps `download`, `extract`, `write`, `hook` and config formats `properties`, `template`.
  `steamcmd`, the other formats and `options_from` lists are M3.

## Templates and quoting

Strings in `image`, `install`, `configs`, `hooks`, `start`, `ready`, `stop`, `console`, `players`, `backup` and
`services` may use `{{vars.<key>}}`, `{{ports.<name>}}`, `{{server.id}}` and `{{server.name}}`. The panel renders
them before anything reaches the host. A filter after `|` quotes the value for where it lands:

| Placeholder | Renders `It's <ok>` as | Use in |
| --- | --- | --- |
| `{{vars.motd}}` | `It's <ok>` | `properties` values, plain config text |
| `{{vars.motd\|sh}}` | `'It'\''s <ok>'` (POSIX single quotes) | `start`, `stop.command`, anything run by `/bin/sh` |
| `{{vars.motd\|json}}` | `"It's <ok>"` | JSON or YAML config templates |

`start` runs through `/bin/sh -c`, so a definition fails validation when a `string` or `secret` variable or
`server.name` appears unfiltered in `start`, `stop.command` or a hook path: write `{{vars.motd|sh}}`. Numbers,
booleans and `select` values (the author's own options) need no filter. Values never contain line breaks or control
characters (the panel refuses them, the server name included).

## Limits and timeouts

- `number` variables may set `min` and `max`; the panel refuses values outside them (400) and the create form shows
  them. A variable with `bind: limits.memory` is the container's memory limit, so size a JVM heap from it with
  `-XX:MaxRAMPercentage=75.0` rather than `-Xmx{{vars.memory}}M` (a heap as large as the limit gets OOM-killed).
- `install_timeout` (seconds, at least 60, default 7200) cancels an install that hangs; the server ends
  `install_failed` and can be reinstalled. A stop request during the install cancels it too.
