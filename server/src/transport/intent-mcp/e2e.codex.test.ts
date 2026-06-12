/**
 * Real-codex end-to-end smoke for the intent HTTP MCP route (2026-06-12-005).
 *
 * Proves the WHOLE driver path against the actual codex binary: codex 0.139 loads
 * `config.mcp_servers.c3 = { url }` (the streamable-HTTP MCP form `codex mcp add
 * --url` writes), connects to c3's loopback route, and can DISCOVER + CALL the
 * intent tools — the thing the in-process integration test can only simulate.
 *
 * MANUAL / default-skip: needs a logged-in codex (auth + a real model) and makes a
 * live LLM call, so it is gated behind `C3_INTENT_MCP_E2E=1` AND codex on PATH —
 * NOT run in normal CI. Run with:
 *   C3_INTENT_MCP_E2E=1 pnpm --filter @ccc/server exec vitest run \
 *     src/transport/intent-mcp/e2e.codex.test.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { createIntentMcp, INTENT_MCP_PATH, type IntentMcpTools } from './index.js'

const hasCodex = !!spawnSync('which', ['codex']).stdout?.toString().trim()
const enabled = process.env.C3_INTENT_MCP_E2E === '1' && hasCodex

describe.skipIf(!enabled)('codex ⇄ intent MCP route end-to-end', () => {
  let findCalled = 0
  const tools: IntentMcpTools = {
    find: () => {
      findCalled++
      return { content: [{ type: 'text', text: '找到 0 条意图:[]' }] }
    },
    view: () => ({ content: [{ type: 'text', text: '{}' }] }),
    save: async () => ({ content: [{ type: 'text', text: 'SAVED' }] }),
  }

  let server: ServerType
  let port: number
  let url: string

  beforeAll(async () => {
    const intentMcp = createIntentMcp('http://127.0.0.1', tools, () => 'e2e-tok')
    const bound = intentMcp.bind({
      projectPath: '/abs/e2e',
      getRunId: () => 'e2e-run',
      signal: new AbortController().signal,
    })
    const app = new Hono()
    app.all(INTENT_MCP_PATH, (c) => intentMcp.handler(c))
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        port = info.port
        resolve()
      })
    })
    url = `http://127.0.0.1:${port}${INTENT_MCP_PATH}?token=${bound.servers.c3.url.split('token=')[1]}`
  })

  afterAll(() => server?.close())

  it('codex discovers and calls find_intents over the route', async () => {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        'codex',
        [
          'exec',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '-c',
          `mcp_servers.c3.url="${url}"`,
          '现在调用 find_intents 这个 MCP 工具(参数留空),并把它返回的内容原样转述给我。',
        ],
        { env: { ...process.env, NO_PROXY: '127.0.0.1,localhost,::1' } },
      )
      child.stdin.end()
      child.on('error', reject)
      child.on('close', resolve)
    })
    expect(code).toBe(0)
    expect(findCalled).toBeGreaterThan(0)
  }, 90_000)
})
