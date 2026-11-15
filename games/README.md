# Starter definitions

One folder per game: `<id>/game.yml` plus any files it references (`hooks/*.sh`, config templates). The panel loads
this folder as the built-in `builtin` source at startup (`GAMES_DIR`); git sources (M3) use the same layout.
Format: `protocol/schema/definition.json` and the blueprint's "A game definition" section.

- Hooks run inside the container as uid 1000 in `/data`, with `GSS_VAR_<KEY>`, `GSS_PORT_<NAME>` and `GSS_SERVER_ID`
  in the environment. Non-zero exit = the step failed.
- M2 supports install steps `download`, `extract`, `write`, `hook` and config formats `properties`, `template`.
  `steamcmd`, the other formats and `options_from` lists are M3.
