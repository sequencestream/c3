# c3

**c3 (Code Creative Center)** is a coding platform that fuses harness and loop
engineering with AI software-engineering practice. Instead of throwing a raw prompt at a
model and hoping for the best, c3 turns vague, half-formed requirements into structured
intents — each with a clear scope, explicit dependencies, and a verifiable definition of done.

## Features

- **Structured intents** — vague requirements become scoped, dependency-aware tasks with a verifiable definition of done.
- **Automated loops** — planning, implementation, and validation run as repeatable, auditable flows.
- **Multi-agent discussions** — perspectives converge before code is written.
- **Scheduled tasks** — long-running and recurring work keeps moving on its own.
- **Spec-first & locally owned** — the spec is the source of truth, and everything runs as a single local process you control.

## Prerequisites

c3 drives Claude Code and Codex, so you need both installed:

- **Claude Code** — `curl -fsSL https://claude.ai/install.sh | bash`, or see the [quickstart](https://code.claude.com/docs/en/quickstart).
- **Codex** — `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, or see the [CLI docs](https://developers.openai.com/codex/cli).

Optional tools:
- **GitHub CLI** — `brew install gh`, or see [cli.github.com](https://cli.github.com/).

## Install / Upgrade

### Homebrew

```bash
# install
brew install sequencestream/tap/c3

# upgrade
brew upgrade c3
```


### Install script

The same commands install c3 and upgrade an existing install to the latest release.

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/sequencestream/c3/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/sequencestream/c3/main/install.ps1 | iex
```

The script always fetches the latest release for your platform, verifies its checksum, and installs `c3` (to `~/.local/bin` on macOS/Linux, or `%LOCALAPPDATA%\c3\bin` on Windows). Re-run it any time to upgrade. Set `C3_INSTALL_DIR` to choose a different location, or `C3_VERSION` to pin a specific version.


### Manual download

Grab the latest build for your platform from the [releases page](https://github.com/sequencestream/c3/releases/) and extract it (to upgrade, extract the new archive over your existing binary):

```bash
# e.g. c3-v0.4.3-macos-arm64.tar.gz
tar -xzvf c3-v0.4.3-macos-arm64.tar.gz
```

> **macOS note:** the first launch may trigger a security warning. Allow c3 to run in *System Settings → Privacy & Security*.

## Usage

Start c3 on port 9000:

```bash
# Installed via Homebrew or the install script (c3 is on your PATH)
c3 --port 9000

# Or, from a manual download (run the extracted binary directly)
./c3 --port 9000
```

Then open http://localhost:9000 in your browser. (`c3 --port 9000` is shorthand for `c3 start --port 9000`.)

### Run in the background

Add `--daemon` to detach from the terminal and keep c3 running in the background:

```bash
c3 --port 9000 --daemon
```

### Install as a service

Register c3 as a per-user OS service (systemd on Linux, launchd on macOS, schtasks on Windows) so it starts automatically and stays running:

```bash
c3 install --port 9000
```

The port and workspace are baked into the service unit. Run `c3 install --help` for the full set of options.
