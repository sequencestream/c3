/**
 * The Claude-boundary translation of the vendor-neutral RemoteMcpServer
 * descriptors into the Claude SDK HTTP MCP config. Both Claude and Codex now reach
 * c3's tools over the SAME loopback HTTP MCP routes; this converter is the only
 * place the neutral descriptor meets an Anthropic SDK shape. We assert that a bound
 * descriptor's loopback URL + per-run token survive the translation, that the tools
 * are marked resident (`alwaysLoad`), and that an empty binding yields no c3 config.
 *
 * The descriptors here mirror exactly what a c3 HTTP MCP route's `bind()` returns
 * (a loopback URL carrying an opaque per-run token); the route wiring itself is
 * covered by the transport route tests. We keep those inline so this kernel test
 * stays within the one-directional kernel→transport boundary.
 */
import { describe, expect, it } from 'vitest'
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { RemoteMcpServer } from '../types.js'
import { remoteMcpToClaudeConfig } from './mcp.js'

describe('remoteMcpToClaudeConfig', () => {
  it('translates a bound loopback descriptor into an HTTP MCP config keeping the URL + token', () => {
    // The exact shape an intent-MCP `bind()` returns: a loopback URL + opaque token.
    const servers: Record<string, RemoteMcpServer> = {
      c3: {
        type: 'http',
        url: 'http://127.0.0.1:3000/internal/intent-mcp/v1?token=tok-123',
        enabledTools: ['find_intents', 'view_intent', 'save_intents'],
      },
    }

    const cfg = remoteMcpToClaudeConfig(servers)
    expect(Object.keys(cfg)).toEqual(['c3'])
    const c3 = cfg.c3 as McpHttpServerConfig
    expect(c3.type).toBe('http')
    // The loopback origin + the per-run opaque token both survive the translation.
    expect(c3.url).toBe('http://127.0.0.1:3000/internal/intent-mcp/v1?token=tok-123')
    // Tools stay resident in the turn-1 prompt (parity with the removed in-process
    // servers' alwaysLoad) — no ToolSearch round-trip before a c3 tool.
    expect(c3.alwaysLoad).toBe(true)
    // No Anthropic-only fields leak from the neutral descriptor (enabledTools is a
    // Codex allowlist concept; the Claude route is limited server-side).
    expect('enabledTools' in c3).toBe(false)
  })

  it('yields an empty config for an empty binding (a run with no c3 profile)', () => {
    expect(remoteMcpToClaudeConfig({})).toEqual({})
  })

  it('preserves the server key so a c3 binding overrides a same-named user server', () => {
    const cfg = remoteMcpToClaudeConfig({
      c3: { type: 'http', url: 'http://127.0.0.1:3000/x?token=t', enabledTools: ['publish_event'] },
    })
    expect(Object.keys(cfg)).toEqual(['c3'])
    expect((cfg.c3 as McpHttpServerConfig).url).toBe('http://127.0.0.1:3000/x?token=t')
  })
})
