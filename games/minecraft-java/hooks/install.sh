#!/bin/sh
# Install hook for minecraft-java. Runs as uid 1000 in /data.
# In: GSS_VAR_FLAVOUR (vanilla|paper), GSS_VAR_VERSION (e.g. 1.21.4 or "latest").
# Out: /data/server.jar, verified against the upstream checksum.
#   vanilla: piston-meta version manifest → version JSON → downloads.server (url + sha1)
#   paper:   api.papermc.io v2 → latest build of the version → application (name + sha256)
# Print one line per step ("Resolving latest Paper for 1.21.4...", "Downloading paper-1.21.4-123.jar...").
set -eu

echo "minecraft-java install hook is not implemented yet (flavour=${GSS_VAR_FLAVOUR:-?}, version=${GSS_VAR_VERSION:-?})" >&2
exit 1 # TODO(builder): C
