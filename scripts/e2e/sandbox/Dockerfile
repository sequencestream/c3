# c3 sandbox E2E base image
#
# The image c3 bind-mounts the run's worktree into at /workspace and that the
# sandbox wrapper runs the vendor CLI inside via:
#   docker exec --env-file <f> -i -w /workspace <cid> <claude|codex> "$@"
#
# So the only hard requirements are: the `claude` and `codex` binaries must be
# on PATH, and the libc must match their native deps. We use Debian bookworm
# (glibc) — NOT alpine — because the codex CLI ships a native (rust) binary that
# needs glibc; musl would fail to start.
#
# claude  ← npm @anthropic-ai/claude-code      (the Claude Code CLI)
# codex   ← npm @openai/codex                   (the OpenAI Codex CLI)
#
# decision (ADR-0024 follow-up — see specs/domains/core/sandbox/spec.md).
#
# Build via scripts/e2e/sandbox/build-image.mjs (tags c3-sandbox-e2e:latest).
FROM node:22-bookworm-slim

# git: c3 mounts a git worktree at /workspace; agents commonly shell out to git.
# ca-certificates: TLS for any real provider egress (RELAY / DIRECT paths).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install the two vendor CLIs globally so `claude` / `codex` resolve on PATH.
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
  && npm cache clean --force

# Build-time smoke: fail the build loudly if either binary is missing or broken
# (wrong package name, bad libc, etc.) rather than discovering it at run time.
RUN claude --version && codex --version

LABEL c3.sandbox.image="e2e" \
  c3.sandbox.vendors="claude,codex"

WORKDIR /workspace

# Default to a long-lived no-op so a `docker run -d <image>` stays up for the
# wrapper's `docker exec` calls. c3's own launch path overrides the command.
CMD ["sleep", "infinity"]
