/**
 * Cursor MCP injection + self-check tests. The CLI runner is faked so the
 * self-check logic is exercised without a live MCP handshake.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CursorMcpError,
  checkCursorMcp,
  cursorMcpConfigPath,
  injectCursorMcp,
  parseMcpList,
} from './mcp.js'

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'c3-cursor-home-'))
  mkdirSync(join(home, '.cursor'), { recursive: true })
  return home
}

const servers = {
  c3: { type: 'http' as const, url: 'http://127.0.0.1:3000/mcp' },
  intent: { type: 'http' as const, url: 'http://127.0.0.1:3001/mcp' },
}

describe('injectCursorMcp', () => {
  it('writes the servers into the data-root mcp.json', () => {
    const home = fakeHome()
    const { dispose } = injectCursorMcp(home, servers)
    const written = JSON.parse(readFileSync(cursorMcpConfigPath(home), 'utf8'))
    expect(written.mcpServers.c3).toEqual({ url: 'http://127.0.0.1:3000/mcp' })
    expect(written.mcpServers.intent).toEqual({ url: 'http://127.0.0.1:3001/mcp' })
    dispose()
  })

  it('removes the file on dispose when it did not previously exist', () => {
    const home = fakeHome()
    const { dispose } = injectCursorMcp(home, servers)
    expect(existsSync(cursorMcpConfigPath(home))).toBe(true)
    dispose()
    expect(existsSync(cursorMcpConfigPath(home))).toBe(false)
  })

  it('preserves the user’s own servers and restores the exact prior bytes', () => {
    const home = fakeHome()
    const path = cursorMcpConfigPath(home)
    // Raw JSON fixture (kernel/ bans JSON.stringify — ADR-0009 R2).
    const prior = '{\n  "mcpServers": {\n    "mine": {\n      "url": "http://x"\n    }\n  }\n}'
    writeFileSync(path, prior)
    const { dispose } = injectCursorMcp(home, servers)
    const merged = JSON.parse(readFileSync(path, 'utf8'))
    expect(merged.mcpServers.mine).toEqual({ url: 'http://x' })
    expect(merged.mcpServers.c3).toBeTruthy()
    dispose()
    expect(readFileSync(path, 'utf8')).toBe(prior)
  })

  it('refuses to overwrite a corrupt existing config', () => {
    const home = fakeHome()
    writeFileSync(cursorMcpConfigPath(home), '{ not json')
    expect(() => injectCursorMcp(home, servers)).toThrow(CursorMcpError)
  })
})

describe('parseMcpList', () => {
  it('maps name to status', () => {
    const map = parseMcpList('c3probe: ready\nother: not loaded (needs approval)\n')
    expect(map.get('c3probe')).toBe('ready')
    expect(map.get('other')).toBe('not loaded (needs approval)')
  })
})

describe('checkCursorMcp', () => {
  it('is visible when every required server is listed', () => {
    const run = () => ({ code: 0, output: 'c3: ready\nintent: not loaded (needs approval)\n' })
    expect(checkCursorMcp(['c3', 'intent'], run)).toEqual({ outcome: 'visible' })
  })

  it('is missing when a clean mcp list does not include a required server', () => {
    const run = () => ({ code: 0, output: 'c3: ready\n' })
    expect(checkCursorMcp(['c3', 'intent'], run)).toEqual({
      outcome: 'missing',
      missing: ['intent'],
    })
  })

  it('is unverifiable (not missing) when the CLI errors', () => {
    const run = () => ({ code: 1, output: 'boom' })
    expect(checkCursorMcp(['c3'], run).outcome).toBe('unverifiable')
  })

  it('is unverifiable (not missing) when the check times out', () => {
    const run = () => ({ code: null, output: '', timedOut: true })
    expect(checkCursorMcp(['c3'], run).outcome).toBe('unverifiable')
  })

  it('is a visible no-op with nothing required', () => {
    expect(checkCursorMcp([], () => ({ code: 1, output: '' }))).toEqual({ outcome: 'visible' })
  })
})
