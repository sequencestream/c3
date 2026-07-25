#!/bin/sh
# c3 sandbox wrapper — runs the vendor CLI inside an arapuca-narrowed process
mkdir -p '/tmp/claude-501' 2>/dev/null || true
exec '/Users/tiltwind/.c3/sandbox/arapuca/0.2.5/arapuca-0.2.5/arapuca' run \
  --seccomp baseline \
  --allow-proxy-env \
  --allow-keychain \
  --cwd '/Users/tiltwind/.c3/worktrees/Users-tiltwind-workspace-github-sequencestream-c3/intent-32ae2d36-636b-4fa2-84ac-b5a6f40f0beb' \
  --env 'USER=tiltwind' \
  --env 'LOGNAME=tiltwind' \
  --env "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" \
  --env "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  --env "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN" \
  -v '/Users/tiltwind/.c3/worktrees/Users-tiltwind-workspace-github-sequencestream-c3/intent-32ae2d36-636b-4fa2-84ac-b5a6f40f0beb:rw' \
  -v '/Users/tiltwind/workspace/github/sequencestream/c3:ro' \
  -v '/Users/tiltwind/.c3/specs/Users-tiltwind-workspace-github-sequencestream-c3:rw' \
  -v '/Users/tiltwind/.claude:rw' \
  -v '/private/tmp/claude-501:rw' \
  -v '/Users/tiltwind/.claude.json:rw' \
  -- 'claude' "$@"
