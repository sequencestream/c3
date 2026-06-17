#!/usr/bin/env bash
# Release the license-server (c3-ls) to the Linux production host.
#
# Flow:
#   1. Read the current release number from .env/release-version.txt (starts at 1).
#   2. Bump .env/release-version.txt by 1 up-front (before building), so a failed
#      build/deploy never reuses v{version} on the next attempt. This release
#      still deploys v{version} (the value just read).
#   3. Build the Linux single binary (`make release` rebuilds web/dist first;
#      set RELEASE_SKIP_WEB=1 to use the committed web/dist and skip the npm build).
#   4. ssh/scp the binary to /opt/c3/releases/c3-ls-v{version} on the host.
#   5. Symlink /opt/c3/c3-ls -> the new release binary.
#   6. Run /opt/c3/restart.sh (owned by ops; holds the C3_LS_* env) to stop the
#      old c3-ls process and start the new one.
#
# Usage:
#   ./scripts/release.sh                 # full release (rebuild web, build, deploy)
#   RELEASE_SKIP_WEB=1 ./scripts/release.sh   # skip the frontend rebuild
set -euo pipefail

# --- Remote target --------------------------------------------------------
SSH_PORT=9922
SSH_HOST='root@8.153.37.83'
REMOTE_BASE='/opt/c3'
REMOTE_RELEASES="$REMOTE_BASE/releases"
REMOTE_LINK="$REMOTE_BASE/c3-ls"
REMOTE_RESTART="$REMOTE_BASE/restart.sh"

# --- Resolve paths (independent of cwd) -----------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$LS_ROOT/.env/release-version.txt"
BINARY="$LS_ROOT/dist/license-server"

# --- Read & validate the release version ----------------------------------
if [[ -f "$VERSION_FILE" ]]; then
  VERSION="$(tr -dc '0-9' < "$VERSION_FILE")"
else
  VERSION=1
fi
if [[ -z "$VERSION" ]]; then
  echo "error: $VERSION_FILE does not contain a numeric version" >&2
  exit 1
fi

RELEASE_BIN="$REMOTE_RELEASES/c3-ls-v$VERSION"
echo "==> releasing c3-ls v$VERSION to $SSH_HOST:$RELEASE_BIN"

# --- Bump the version file up-front (before build) ------------------------
# Persist the next version now so a failed build/deploy doesn't reuse v$VERSION.
echo $((VERSION + 1)) > "$VERSION_FILE"
echo "==> bumped $VERSION_FILE to $((VERSION + 1)) (next release)"

# --- Build the Linux binary -----------------------------------------------
cd "$LS_ROOT"
if [[ "${RELEASE_SKIP_WEB:-}" == "1" ]]; then
  echo "==> building (RELEASE_SKIP_WEB=1, using committed web/dist)"
  make build
else
  echo "==> building (rebuilding web/dist, then Linux binary)"
  make release
fi

if [[ ! -f "$BINARY" ]]; then
  echo "error: expected binary not found at $BINARY" >&2
  exit 1
fi

# --- Deploy ---------------------------------------------------------------
echo "==> uploading binary"
ssh -p "$SSH_PORT" "$SSH_HOST" "mkdir -p '$REMOTE_RELEASES'"
scp -P "$SSH_PORT" "$BINARY" "$SSH_HOST:$RELEASE_BIN"

echo "==> linking $REMOTE_LINK -> $RELEASE_BIN and restarting"
ssh -p "$SSH_PORT" "$SSH_HOST" "
  set -e
  chmod +x '$RELEASE_BIN'
  ln -sfn '$RELEASE_BIN' '$REMOTE_LINK'
  '$REMOTE_RESTART'
"

echo "==> done: released v$VERSION; next version is $((VERSION + 1))"
