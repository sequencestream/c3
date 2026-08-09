/**
 * Project MCP file write/restore.
 *
 * The file belongs to the user's workspace, so what is pinned here is that a run
 * leaves it exactly as it found it, and that a user's own servers keep working
 * while c3's are attached.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupCursorMcpConfig, writeCursorMcpConfig } from './mcp-config.js'
import type { RemoteMcpServer } from '../types.js'

let cwd = ''
const C3_SERVER: RemoteMcpServer = { type: 'http', url: 'http://127.0.0.1:3000/mcp/tok' }

function configPath(): string {
  return join(cwd, '.cursor', 'mcp.json')
}

function readConfig(): { mcpServers: Record<string, { url?: string; headers?: unknown }> } {
  return JSON.parse(readFileSync(configPath(), 'utf-8'))
}

function writeExisting(text: string): void {
  mkdirSync(join(cwd, '.cursor'), { recursive: true })
  writeFileSync(configPath(), text, 'utf-8')
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'c3-cursor-mcp-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('writeCursorMcpConfig', () => {
  it('attaches nothing, and needs no cleanup, when the run has no servers', () => {
    expect(writeCursorMcpConfig(cwd, undefined)).toBeNull()
    expect(writeCursorMcpConfig(cwd, {})).toBeNull()
    expect(existsSync(configPath())).toBe(false)
  })

  it('writes the run’s servers into the project file', () => {
    const handle = writeCursorMcpConfig(cwd, { c3: C3_SERVER })

    expect(handle?.previous).toBeNull()
    expect(readConfig().mcpServers.c3).toEqual({ url: 'http://127.0.0.1:3000/mcp/tok' })
  })

  it('carries a bearer token as an Authorization header', () => {
    process.env.C3_MCP_TEST_TOKEN = 'secret-value'
    try {
      writeCursorMcpConfig(cwd, {
        c3: { ...C3_SERVER, bearerTokenEnvVar: 'C3_MCP_TEST_TOKEN' },
      })
      expect(readConfig().mcpServers.c3?.headers).toEqual({
        Authorization: 'Bearer secret-value',
      })
    } finally {
      delete process.env.C3_MCP_TEST_TOKEN
    }
  })

  it('keeps the workspace’s own servers alongside c3’s', () => {
    writeExisting('{"mcpServers":{"mine":{"command":"/bin/echo","args":["hi"]}}}')

    writeCursorMcpConfig(cwd, { c3: C3_SERVER })

    const written = readConfig().mcpServers
    expect(Object.keys(written).sort()).toEqual(['c3', 'mine'])
    // The user's entry survives with its own fields, not a normalized rewrite.
    expect(written.mine).toEqual({ command: '/bin/echo', args: ['hi'] })
  })

  it('escapes values that would otherwise break the file', () => {
    writeCursorMcpConfig(cwd, {
      'weird"name': { type: 'http', url: 'http://x/?q="a"\\b' },
    })
    expect(readConfig().mcpServers['weird"name']).toEqual({ url: 'http://x/?q="a"\\b' })
  })
})

describe('protecting the workspace it writes into', () => {
  it('refuses a second concurrent run rather than stealing the first one’s file', () => {
    const first = writeCursorMcpConfig(cwd, { c3: C3_SERVER })
    try {
      // Overwriting would leave the first run's cleanup restoring the file out
      // from under the second, which is still using it.
      expect(() => writeCursorMcpConfig(cwd, { c3: C3_SERVER })).toThrow(/another run/)
    } finally {
      cleanupCursorMcpConfig(first)
    }
    // Once the first run releases it, the next one proceeds normally.
    const second = writeCursorMcpConfig(cwd, { c3: C3_SERVER })
    expect(second).not.toBeNull()
    cleanupCursorMcpConfig(second)
  })

  it('hides the file from git locally, without touching the user’s .gitignore', () => {
    mkdirSync(join(cwd, '.git', 'info'), { recursive: true })
    writeFileSync(join(cwd, '.gitignore'), 'node_modules\n', 'utf-8')

    cleanupCursorMcpConfig(writeCursorMcpConfig(cwd, { c3: C3_SERVER }))

    // The URL carries a per-run token; an agent running `git add -A` must not be
    // able to commit it.
    expect(readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '.cursor/mcp.json',
    )
    expect(readFileSync(join(cwd, '.gitignore'), 'utf-8')).toBe('node_modules\n')
  })

  it('follows a linked worktree’s .git pointer to the real exclude file', () => {
    // c3's isolated checkouts are exactly this shape: `.git` is a file, not a dir.
    const realGitDir = join(cwd, 'real-git')
    mkdirSync(join(realGitDir, 'info'), { recursive: true })
    writeFileSync(join(cwd, '.git'), `gitdir: ${realGitDir}\n`, 'utf-8')

    cleanupCursorMcpConfig(writeCursorMcpConfig(cwd, { c3: C3_SERVER }))

    expect(readFileSync(join(realGitDir, 'info', 'exclude'), 'utf-8')).toContain('.cursor/mcp.json')
  })

  it('appends the exclude entry only once across runs', () => {
    mkdirSync(join(cwd, '.git', 'info'), { recursive: true })
    for (let i = 0; i < 3; i++) cleanupCursorMcpConfig(writeCursorMcpConfig(cwd, { c3: C3_SERVER }))
    const lines = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim() === '.cursor/mcp.json')
    expect(lines).toHaveLength(1)
  })

  it('drops a file a killed run left behind instead of restoring its stale token', () => {
    // A leftover holds a dead per-run token. Treating it as "the user's file"
    // would write it back at the end of this turn.
    writeExisting('{"mcpServers":{"c3":{"url":"http://127.0.0.1:3000/mcp/stale-token"}}}')

    const handle = writeCursorMcpConfig(cwd, { c3: C3_SERVER })
    expect(handle?.previous).toBeNull()

    cleanupCursorMcpConfig(handle)
    expect(existsSync(configPath())).toBe(false)
  })

  it('still preserves a real user file that happens to sit alongside', () => {
    writeExisting('{"mcpServers":{"mine":{"command":"/bin/echo"}}}')
    const handle = writeCursorMcpConfig(cwd, { c3: C3_SERVER })
    expect(handle?.previous).not.toBeNull()
    cleanupCursorMcpConfig(handle)
    expect(readConfig().mcpServers.mine).toEqual({ command: '/bin/echo' })
  })
})

describe('cleanupCursorMcpConfig', () => {
  it('removes a file the run created', () => {
    const handle = writeCursorMcpConfig(cwd, { c3: C3_SERVER })
    cleanupCursorMcpConfig(handle)
    expect(existsSync(configPath())).toBe(false)
  })

  it('restores prior contents byte for byte, including formatting', () => {
    const original = '{\n  "mcpServers": {\n    "mine": { "url": "http://mine" }\n  }\n}\n'
    writeExisting(original)

    const handle = writeCursorMcpConfig(cwd, { c3: C3_SERVER })
    cleanupCursorMcpConfig(handle)

    expect(readFileSync(configPath(), 'utf-8')).toBe(original)
  })

  it('restores an unparseable file untouched rather than rewriting it', () => {
    // c3 could not merge into it, but it is still the user's file.
    const original = '{ not json at all'
    writeExisting(original)

    cleanupCursorMcpConfig(writeCursorMcpConfig(cwd, { c3: C3_SERVER }))

    expect(readFileSync(configPath(), 'utf-8')).toBe(original)
  })

  it('does nothing when the run attached nothing', () => {
    expect(() => cleanupCursorMcpConfig(null)).not.toThrow()
  })

  it('survives a workspace that vanished mid-run', () => {
    const handle = writeCursorMcpConfig(cwd, { c3: C3_SERVER })
    rmSync(cwd, { recursive: true, force: true })
    expect(() => cleanupCursorMcpConfig(handle)).not.toThrow()
  })
})
