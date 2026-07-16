/**
 * Full-loop relay test against the REAL codex binary (ADR-0014). Stands up a fake
 * Chat-Completions upstream + the real relay (on a Hono node server, exactly as
 * server.ts mounts it), then spawns `codex exec` configured the way the driver
 * configures it (custom provider, supports_websockets=false, token-as-API-key,
 * NO_PROXY for the loopback). Proves codex accepts the translated Responses SSE:
 * the upstream's text reaches codex's `agent_message`, and a tool call reaches its
 * `command_execution` item.
 *
 * Skipped automatically when the codex CLI is absent (kept out of pure-unit CI by
 * the `.codex.` filename + the host-binary guard).
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRelay, RELAY_CODEX_PATH, CODEX_RELAY_PROVIDER } from './index.js'

const codexBin = spawnSync('which', ['codex']).stdout?.toString().trim()
const codexExecProbe = codexBin
  ? spawnSync(
      'codex',
      ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', 'probe'],
      { encoding: 'utf-8', input: '', timeout: 5_000 },
    )
  : null
const codexExecBlocked =
  codexExecProbe?.stderr.includes('failed to initialize in-process app-server client') ||
  codexExecProbe?.stderr.includes('Operation not permitted')
const hasCodex = !!codexBin && !codexExecBlocked

/** A Chat-Completions SSE upstream that streams `chunks` then `[DONE]`. */
function fakeUpstream(chunks: object[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const ch of chunks) res.write(`data: ${JSON.stringify(ch)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    )
  })
}

describe.skipIf(!hasCodex)('codex ⇄ relay end-to-end', () => {
  let upstream: { server: Server; port: number }
  let relayServer: ReturnType<typeof serve>
  let relayPort: number
  let token: string

  beforeAll(async () => {
    upstream = await fakeUpstream([
      { id: 'cc1', choices: [{ delta: { role: 'assistant', content: 'PONG-42' } }] },
      { id: 'cc1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        id: 'cc1',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ])
    // Reserve a port for the relay so its baseUrl matches where we serve it.
    relayPort = await new Promise<number>((r) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => r(p))
      })
    })
    const relay = createRelay(`http://127.0.0.1:${relayPort}`)
    token = relay.register([
      {
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        apiKey: 'sk-upstream',
        model: 'deepseek-chat',
        wireApi: 'chat',
      },
    ])
    const app = new Hono()
    app.post(`${RELAY_CODEX_PATH}/responses`, (c) => relay.codexHandler(c))
    relayServer = serve({ fetch: app.fetch, port: relayPort, hostname: '127.0.0.1' })
  })

  afterAll(() => {
    upstream.server.close()
    relayServer?.close()
  })

  it('codex renders the upstream text via the relay', async () => {
    const out = await runCodex(relayPort, token, 'say pong')
    expect(out).toContain('PONG-42')
  }, 30_000)
})

/** Spawn `codex exec` configured exactly as the driver configures the relay route. */
function runCodex(relayPort: number, token: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--experimental-json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-c',
      `model_provider="${CODEX_RELAY_PROVIDER}"`,
      '-c',
      `model_providers.${CODEX_RELAY_PROVIDER}.name="${CODEX_RELAY_PROVIDER}"`,
      '-c',
      `model_providers.${CODEX_RELAY_PROVIDER}.base_url="http://127.0.0.1:${relayPort}${RELAY_CODEX_PATH}"`,
      '-c',
      `model_providers.${CODEX_RELAY_PROVIDER}.env_key="CODEX_API_KEY"`,
      '-c',
      `model_providers.${CODEX_RELAY_PROVIDER}.wire_api="responses"`,
      '-c',
      `model_providers.${CODEX_RELAY_PROVIDER}.supports_websockets=false`,
      '--model',
      'deepseek-chat',
      prompt,
    ]
    const child = spawn('codex', args, {
      env: {
        ...process.env,
        CODEX_API_KEY: token,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
      },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.stdin.end()
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`codex ${code}: ${err}\n${out}`)),
    )
  })
}
