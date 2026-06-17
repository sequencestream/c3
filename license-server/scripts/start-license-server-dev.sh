#!/usr/bin/env bash
# Start the license-server locally for development.
#
# It sources the gitignored env file (.env/license-server-dev.sh) for the
# database DSN, signing seed, and other C3_LS_* knobs, then runs the server
# straight from source with `go run` (the committed web/dist is embedded).
#
#   ./scripts/start-license-server-dev.sh            # start on $C3_LS_LISTEN_ADDR
#
# Any extra args are passed through to the server binary.
set -euo pipefail

# Resolve the license-server root from this script's location, independent of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$LS_ROOT/.env/license-server-dev.sh"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing env file $ENV_FILE" >&2
  echo "       copy the template and fill in secrets:" >&2
  echo "       cp '$LS_ROOT/.env/license-server-dev.sh.example' '$ENV_FILE'" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

echo "license-server dev: listen=${C3_LS_LISTEN_ADDR:-:8787} db=$([[ -n "${C3_LS_DATABASE_URL:-}" ]] && echo set || echo unset) signing=$([[ -n "${C3_LS_ED25519_PRIVATE_KEY:-}" ]] && echo set || echo unset)"

cd "$LS_ROOT"
exec go run ./cmd/license-server "$@"
