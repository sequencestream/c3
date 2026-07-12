#!/bin/sh
# c3 installer — install or update to the latest release.
#
#   curl -fsSL https://raw.githubusercontent.com/sequencestream/c3/main/install.sh | sh
#
# Environment overrides:
#   C3_VERSION       pin a specific version (e.g. v0.4.0); defaults to latest
#   C3_INSTALL_DIR   install directory; defaults to ~/.local/bin
set -eu

REPO="sequencestream/c3"
INSTALL_DIR="${C3_INSTALL_DIR:-$HOME/.local/bin}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
err()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- pick a download tool -------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fsSL "$1" -o "$2"; }
  dl_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -qO "$2" "$1"; }
  dl_stdout() { wget -qO- "$1"; }
else
  err "curl or wget is required"
fi

# --- detect platform ------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) platform="macos-arm64" ;;
      *) err "unsupported macOS arch: $arch (only Apple Silicon builds are published)" ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64|amd64) platform="linux-x64" ;;
      *) err "unsupported Linux arch: $arch (only x64 builds are published)" ;;
    esac
    ;;
  *)
    err "unsupported OS: $os (use the Windows zip from the releases page)" ;;
esac

# --- resolve version ------------------------------------------------------
version="${C3_VERSION:-}"
if [ -z "$version" ]; then
  info "Resolving latest version..."
  version="$(dl_stdout "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$version" ] || err "could not determine latest version"
fi
info "Installing c3 $version ($platform)"

# --- download & verify ----------------------------------------------------
asset="c3-$version-$platform.tar.gz"
base="https://github.com/$REPO/releases/download/$version"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "Downloading $asset"
dl "$base/$asset" "$tmp/$asset"

if dl "$base/$asset.sha256" "$tmp/$asset.sha256" 2>/dev/null; then
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  else
    actual=""
    warn "no sha256 tool found; skipping checksum verification"
  fi
  if [ -n "$actual" ]; then
    [ "$expected" = "$actual" ] || err "checksum mismatch for $asset"
    info "Checksum verified"
  fi
else
  warn "checksum file not found; skipping verification"
fi

# --- install --------------------------------------------------------------
info "Extracting"
tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/c3" ] || err "c3 binary not found in archive"

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp/c3" "$INSTALL_DIR/c3" 2>/dev/null \
  || { cp "$tmp/c3" "$INSTALL_DIR/c3" && chmod 0755 "$INSTALL_DIR/c3"; }

info "Installed c3 to $INSTALL_DIR/c3"

# --- PATH hint ------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add it, e.g.:
    export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

printf '\033[1;32m✓ c3 %s is ready.\033[0m Run: c3 --port 9000\n' "$version"
