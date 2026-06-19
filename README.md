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

## Install

### Homebrew (recommended)

```bash
brew install sequencestream/tap/c3

# upgrade c3
brew upgrade c3
```

### Manual download

Grab the latest build for your platform from the [releases page](https://github.com/sequencestream/c3/releases/) and extract it:

```bash
# e.g. c3-v0.2.0-macos-arm64.tar.gz
tar -xzvf c3-v0.2.0-macos-arm64.tar.gz
```

> **macOS note:** the first launch may trigger a security warning. Allow c3 to run in
> *System Settings → Privacy & Security*.

## Usage

Start c3 on port 9000:

```bash
# Installed via Homebrew (c3 is on your PATH)
c3 --port 9000

# Or, from a manual download (run the extracted binary directly)
./c3 --port 9000
```

Then open http://localhost:9000 in your browser.
