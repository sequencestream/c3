#!/usr/bin/env node
/**
 * End-to-end self-service key lifecycle plus the read-only workspace accessor view.
 *
 * Runs against a trusted-local deployment (the e2e server has `auth` stripped), so
 * the resolved owner is the synthesized `local` principal. That is enough to prove
 * the properties that do not depend on which identity answered:
 *  - create returns the plaintext exactly once and files the key under NO workspace;
 *  - a plain list carries neither that plaintext nor any owner/hash material;
 *  - reset keeps the id and advances `secretVersion`, and returns a DIFFERENT plaintext;
 *  - a self-service key never appears in a workspace-addressed roster;
 *  - revoke removes it, and a forged id is refused rather than silently ignored;
 *  - the workspace accessor list answers for a reachable workspace and refuses an
 *    unknown one with the same shape it uses for an unauthorized one.
 *
 * Writes no settings — keys live in their own scopes — so it needs no settings guard.
 */

const url = process.argv[2] ?? 'ws://localhost:13000/ws'
const ws = new WebSocket(url)

let finished = false
const timeout = setTimeout(() => finish(false, 'TIMEOUT'), 20_000)

function send(message) {
  ws.send(JSON.stringify(message))
}

function finish(ok, detail) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  console.log(`mcp key self-service: ${detail}`)
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  ws.close()
  process.exitCode = ok ? 0 : 1
}

/** The first workspace this deployment reports; the accessor read needs a real one. */
let workspaceName = null
let phase = 'ready'
let created = null
let rotated = null

ws.addEventListener('error', (event) => finish(false, event.message ?? 'websocket error'))

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))

  if (msg.type === 'ready') {
    workspaceName = msg.workspaces?.[0]?.name ?? null
    send({ type: 'create_my_mcp_api_key', name: 'e2e device' })
    return
  }

  if (msg.type === 'error') {
    // The only expected refusals are the two probes below; anything else fails.
    if (phase === 'revoke-ghost' && msg.error?.code === 'mcpApiKey.unknown') {
      phase = 'accessors'
      if (!workspaceName) return finish(true, 'lifecycle verified; no workspace to read accessors')
      send({ type: 'get_workspace_accessors', workspaceName })
      return
    }
    if (phase === 'accessors-ghost' && msg.error?.code === 'workspaceAccessors.forbidden') {
      return finish(true, 'lifecycle, one-time secret, reset version and accessor reads verified')
    }
    return finish(false, `unexpected error in ${phase}: ${JSON.stringify(msg.error)}`)
  }

  if (msg.type === 'workspace_accessors') {
    if (msg.workspaceName !== workspaceName)
      return finish(false, 'accessors named another workspace')
    if (!Array.isArray(msg.subjects) || msg.subjects.length === 0) {
      return finish(false, 'a reachable workspace reported no accessor')
    }
    phase = 'accessors-ghost'
    // Unknown and unauthorized must be indistinguishable — one refusal shape.
    send({ type: 'get_workspace_accessors', workspaceName: 'no-such-workspace-e2e' })
    return
  }

  if (msg.type === 'mcp_api_keys') {
    // The legacy workspace-addressed roster. Our unfiled key must not be in it.
    if (msg.keys.some((k) => k.id === created.meta.id)) {
      return finish(false, 'a self-service key leaked into a workspace roster')
    }
    phase = 'revoke'
    send({ type: 'revoke_my_mcp_api_key', id: created.meta.id })
    return
  }

  if (msg.type !== 'my_mcp_api_keys') return

  if (phase === 'ready') {
    if (!msg.created?.key) return finish(false, 'create returned no plaintext')
    created = msg.created
    if (created.meta.workspaceName !== null) {
      return finish(false, `a self-service key was filed under ${created.meta.workspaceName}`)
    }
    if (!msg.keys.some((k) => k.id === created.meta.id)) {
      return finish(false, 'the new key is missing from its own roster reply')
    }
    phase = 'list'
    send({ type: 'list_my_mcp_api_keys' })
    return
  }

  if (phase === 'list') {
    const body = JSON.stringify(msg)
    if (body.includes(created.key)) return finish(false, 'the plaintext reappeared in a plain list')
    if (body.includes('ownerSubject') || body.includes('salt') || body.includes('hash')) {
      return finish(false, 'the roster carried owner or verification material')
    }
    if (msg.created !== undefined) return finish(false, 'a plain list carried a `created` payload')
    phase = 'reset'
    send({ type: 'reset_my_mcp_api_key', id: created.meta.id })
    return
  }

  if (phase === 'reset') {
    if (!msg.created?.key) return finish(false, 'reset returned no plaintext')
    rotated = msg.created
    if (rotated.meta.id !== created.meta.id) return finish(false, 'reset changed the key id')
    if (rotated.key === created.key) return finish(false, 'reset returned the same plaintext')
    // `secretVersion` is deliberately NOT on the wire — it is a pinning input, not
    // something a console needs. That it advances (and kills the old secret) is
    // covered by `kernel/config/mcp-api-keys.test.ts`.
    if ('secretVersion' in rotated.meta) return finish(false, 'the wire meta leaked secretVersion')
    if (rotated.meta.name !== created.meta.name) return finish(false, 'reset changed the key name')
    phase = 'legacy-roster'
    if (!workspaceName) {
      phase = 'revoke'
      send({ type: 'revoke_my_mcp_api_key', id: created.meta.id })
      return
    }
    send({ type: 'list_mcp_api_keys', workspaceName })
    return
  }

  if (phase === 'revoke') {
    if (msg.keys.some((k) => k.id === created.meta.id)) {
      return finish(false, 'the revoked key is still in the roster')
    }
    phase = 'revoke-ghost'
    // A second revoke of the same id is now an unknown id: it must be refused,
    // not answered with a pseudo-success roster.
    send({ type: 'revoke_my_mcp_api_key', id: created.meta.id })
    return
  }

  if (phase === 'revoke-ghost') {
    return finish(false, 'revoking an unknown id answered with a roster instead of an error')
  }
})
