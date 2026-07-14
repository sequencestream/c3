import { describe, expect, it } from 'vitest'
import type { AgentConfig, Automation } from '@ccc/shared/protocol'
import {
  AUTOMATION_EXPORT_VERSION,
  buildExportFile,
  exportFilename,
  mapToCreateInput,
  parseImportFile,
  serializeExportFile,
} from './import-export'

function makeAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    type: 'command',
    config: { command: 'echo hi', name: 'Task One' },
    maxWallClockMs: null,
    workspaceId: '/abs/ws',
    vendor: 'claude',
    agentId: null,
    triggerType: 'cron',
    cronExpression: '*/5 * * * *',
    nextRunAt: 123,
    eventFilters: null,
    eventSessionKindFilter: null,
    metadata: {},
    status: 'active',
    mode: 'read-only',
    toolAllowlist: [],
    toolDenylist: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

const AGENTS: AgentConfig[] = [
  { id: 'claude-1', vendor: 'claude', configMode: 'system', displayName: 'C', enabled: true },
  { id: 'codex-1', vendor: 'codex', configMode: 'system', displayName: 'X', enabled: true },
  { id: 'claude-off', vendor: 'claude', configMode: 'system', displayName: 'D', enabled: false },
] as unknown as AgentConfig[]

describe('buildExportFile / serializeExportFile', () => {
  it('produces a v1 envelope with an ISO timestamp and only the selected members', () => {
    const a = makeAutomation({ id: 'a1' })
    const b = makeAutomation({ id: 'b2' })
    const file = buildExportFile([a, b], new Set(['a1']), '2026-07-12T05:27:45.000Z')
    expect(file.version).toBe(AUTOMATION_EXPORT_VERSION)
    expect(file.version).toBe(1)
    expect(file.exportedAt).toBe('2026-07-12T05:27:45.000Z')
    expect(file.automations.map((x) => x.id)).toEqual(['a1'])
  })

  it('deep-copies whole objects, so a protocol-new config field is preserved (no whitelist)', () => {
    const a = makeAutomation({
      // A field the current codec has never heard of — must survive export.
      config: { command: 'echo', name: 'N', someFutureField: { nested: [1, 2, 3] } },
    })
    const file = buildExportFile([a], new Set(['a1']), '2026-07-12T05:27:45.000Z')
    const cfg = file.automations[0].config as Record<string, unknown>
    expect(cfg.someFutureField).toEqual({ nested: [1, 2, 3] })
    // The copy is detached from the source object.
    ;(a.config as Record<string, unknown>).command = 'mutated'
    expect((file.automations[0].config as Record<string, unknown>).command).toBe('echo')
  })

  it('serializes to valid, round-trippable JSON', () => {
    const file = buildExportFile([makeAutomation()], new Set(['a1']), '2026-07-12T05:27:45.000Z')
    const text = serializeExportFile(file)
    expect(() => JSON.parse(text)).not.toThrow()
    expect(JSON.parse(text).version).toBe(1)
  })

  it('empty selection yields an empty automations array', () => {
    const file = buildExportFile([makeAutomation()], new Set<string>(), '2026-07-12T05:27:45.000Z')
    expect(file.automations).toEqual([])
  })
})

describe('exportFilename', () => {
  it('embeds a sanitized workspace name and a compact UTC stamp', () => {
    const date = new Date('2026-07-12T05:27:45.000Z')
    expect(exportFilename('/Users/x/my repo!', date)).toBe(
      'c3-automations-my-repo-20260712T052745Z.json',
    )
  })

  it('falls back to "workspace" for an empty path', () => {
    const date = new Date('2026-07-12T05:27:45.000Z')
    expect(exportFilename('', date)).toBe('c3-automations-workspace-20260712T052745Z.json')
  })
})

describe('parseImportFile', () => {
  it('rejects invalid JSON', () => {
    expect(parseImportFile('{not json')).toEqual({ ok: false, errorKey: 'badJson' })
  })
  it('rejects a non-object root', () => {
    expect(parseImportFile('[]')).toEqual({ ok: false, errorKey: 'badStructure' })
  })
  it('rejects a wrong version (strict !== 1)', () => {
    expect(parseImportFile(JSON.stringify({ version: 2, automations: [] }))).toEqual({
      ok: false,
      errorKey: 'badVersion',
    })
    expect(parseImportFile(JSON.stringify({ version: '1', automations: [] }))).toEqual({
      ok: false,
      errorKey: 'badVersion',
    })
  })
  it('rejects a non-array automations', () => {
    expect(parseImportFile(JSON.stringify({ version: 1, automations: {} }))).toEqual({
      ok: false,
      errorKey: 'badStructure',
    })
  })
  it('rejects a non-object member', () => {
    expect(parseImportFile(JSON.stringify({ version: 1, automations: [1] }))).toEqual({
      ok: false,
      errorKey: 'badStructure',
    })
  })
  it('accepts a valid empty array', () => {
    expect(parseImportFile(JSON.stringify({ version: 1, automations: [] }))).toEqual({
      ok: true,
      automations: [],
    })
  })
})

describe('mapToCreateInput — fault-tolerant field mapping', () => {
  const opts = { workspaceId: '/abs/current', agents: AGENTS }

  it('maps a full command automation and forces paused + current workspace + fresh instance state', () => {
    const raw = makeAutomation({
      id: 'exported-id',
      workspaceId: '/abs/other',
      status: 'active',
      nextRunAt: 999,
      config: { command: 'echo hi', name: 'Kept Name' },
      maxWallClockMs: 5000,
      toolAllowlist: ['Read'],
    }) as unknown as Record<string, unknown>
    const result = mapToCreateInput(raw, opts)
    expect(result.importable).toBe(true)
    if (!result.importable) return
    expect(result.input.workspaceId).toBe('/abs/current')
    expect(result.input.initialStatus).toBe('paused')
    expect(result.input.initialName).toBe('Kept Name')
    expect(result.input.maxWallClockMs).toBe(5000)
    expect(result.input.toolAllowlist).toEqual(['Read'])
    // Instance fields never leak into the create input.
    expect('id' in result.input).toBe(false)
    expect('status' in result.input).toBe(false)
    expect('nextRunAt' in result.input).toBe(false)
  })

  it('falls back per field when values are missing / wrong-typed / unknown', () => {
    const result = mapToCreateInput(
      {
        type: 'nonsense',
        vendor: 42,
        mode: 123,
        maxWallClockMs: 'huge',
        triggerType: 'weird',
        cronExpression: 999,
        toolAllowlist: 'not-array',
        metadata: 'nope',
      },
      opts,
    )
    expect(result.importable).toBe(true)
    if (!result.importable) return
    expect(result.input.type).toBe('command')
    expect(result.input.vendor).toBe('claude')
    expect(result.input.mode).toBe('read-only')
    expect(result.input.maxWallClockMs).toBeNull()
    expect(result.input.triggerType).toBe('cron')
    expect(result.input.cronExpression).toBe('*/30 * * * *')
    expect(result.input.toolAllowlist).toEqual([])
    expect(result.input.metadata).toEqual({})
  })

  it('normalizes a cron trigger by clearing the event filter (legacy topic ignored)', () => {
    const result = mapToCreateInput(
      {
        type: 'command',
        triggerType: 'cron',
        cronExpression: '0 0 * * *',
        eventTopic: 'run:settled',
      },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.triggerType).toBe('cron')
    expect(result.input.eventFilters).toBeNull()
    expect(result.input.eventSessionKindFilter).toBeNull()
  })

  it('projects a legacy run-lifecycle event trigger to a generic filter and clears cron', () => {
    const result = mapToCreateInput(
      {
        type: 'command',
        triggerType: 'event',
        eventTopic: 'run:settled',
        cronExpression: '0 0 * * *',
        eventReasonFilter: ['error', 'bogus'],
        eventSessionKindFilter: ['work', 'intent', 'bogus'],
      },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.triggerType).toBe('event')
    expect(result.input.cronExpression).toBe('')
    expect(result.input.eventFilters).toEqual([{ type: 'run:settled', statuses: ['error'] }])
    expect(result.input.eventSessionKindFilter).toEqual(['work', 'intent'])
  })

  it('accepts a new-format eventFilters directly (round-tripping a modern export)', () => {
    const result = mapToCreateInput(
      {
        type: 'command',
        triggerType: 'event',
        eventFilters: [{ type: 'run:settled', statuses: ['error'] }],
        eventSessionKindFilter: ['work'],
      },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.triggerType).toBe('event')
    expect(result.input.eventFilters).toEqual([{ type: 'run:settled', statuses: ['error'] }])
  })

  it('keeps a run-lifecycle trigger with an empty sessionKind filter unrestricted (no ["work"] fallback)', () => {
    const result = mapToCreateInput(
      {
        type: 'command',
        triggerType: 'event',
        eventTopic: 'run:started',
        eventSessionKindFilter: [],
      },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.eventSessionKindFilter).toBeNull()
  })

  it('keeps a run-lifecycle trigger with an absent sessionKind filter unrestricted', () => {
    const result = mapToCreateInput(
      { type: 'command', triggerType: 'event', eventTopic: 'run:started' },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.eventSessionKindFilter).toBeNull()
  })

  it('keeps a run-lifecycle trigger with an all-invalid sessionKind filter unrestricted', () => {
    const result = mapToCreateInput(
      {
        type: 'command',
        triggerType: 'event',
        eventTopic: 'run:started',
        eventSessionKindFilter: ['bogus', 42, null],
      },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.eventSessionKindFilter).toBeNull()
  })

  it('demotes an event trigger with no resolvable event type to the cron default', () => {
    const result = mapToCreateInput({ type: 'command', triggerType: 'event' }, opts)
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.triggerType).toBe('cron')
    expect(result.input.cronExpression).toBe('*/30 * * * *')
    expect(result.input.eventFilters).toBeNull()
  })

  it('accepts a custom (non-hardcoded) event type with no protocol enum change', () => {
    const result = mapToCreateInput(
      {
        type: 'command',
        triggerType: 'event',
        eventFilters: [{ type: 'custom:thing', statuses: ['ok'] }],
      },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.triggerType).toBe('event')
    expect(result.input.eventFilters).toEqual([{ type: 'custom:thing', statuses: ['ok'] }])
    // A custom (non-run-lifecycle) type carries no sessionKind boundary.
    expect(result.input.eventSessionKindFilter).toBeNull()
  })

  it('projects a legacy pr:operation filter and ignores unknown enum members', () => {
    const result = mapToCreateInput(
      {
        type: 'command',
        triggerType: 'event',
        eventTopic: 'pr:operation',
        eventPrFilter: { operations: ['merge', 'bogus'], results: ['success'] },
      },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.eventFilters).toEqual([{ type: 'pr:merge', statuses: ['success'] }])
  })

  it('keeps a valid exported llm agentId of the same vendor', () => {
    const result = mapToCreateInput({ type: 'llm', vendor: 'claude', agentId: 'claude-1' }, opts)
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.agentId).toBe('claude-1')
  })

  it('falls back an invalid llm agentId to a same-vendor enabled agent', () => {
    const result = mapToCreateInput({ type: 'llm', vendor: 'claude', agentId: 'gone' }, opts)
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.agentId).toBe('claude-1')
  })

  it('does not use a disabled or wrong-vendor agent as the llm fallback', () => {
    const onlyDisabled: AgentConfig[] = [
      {
        id: 'claude-off',
        vendor: 'claude',
        configMode: 'system',
        displayName: 'D',
        enabled: false,
      },
      { id: 'codex-1', vendor: 'codex', configMode: 'system', displayName: 'X', enabled: true },
    ] as unknown as AgentConfig[]
    const result = mapToCreateInput(
      { type: 'llm', vendor: 'claude' },
      {
        workspaceId: '/abs/current',
        agents: onlyDisabled,
      },
    )
    expect(result.importable).toBe(false)
    if (result.importable) return
    expect(result.reasonKey).toBe('noAgent')
  })

  it('marks an llm item non-importable when no compatible agent exists', () => {
    const result = mapToCreateInput(
      { type: 'llm', vendor: 'codex', agentId: 'x' },
      {
        workspaceId: '/abs/current',
        agents: [],
      },
    )
    expect(result.importable).toBe(false)
    if (result.importable) return
    expect(result.reasonKey).toBe('noAgent')
  })

  it('a command item never needs an agent (agentId null)', () => {
    const result = mapToCreateInput(
      { type: 'command' },
      { workspaceId: '/abs/current', agents: [] },
    )
    if (!result.importable) throw new Error('expected importable')
    expect(result.input.agentId).toBeNull()
  })

  it('carries embedEventContext through the export → import round-trip verbatim', () => {
    // Export deep-clones whole automations, so a modern config field survives the
    // envelope; import maps `config` verbatim (the server re-enforces the boundary).
    const file = buildExportFile(
      [
        makeAutomation({
          id: 'evt-llm',
          type: 'llm',
          vendor: 'claude',
          agentId: 'claude-1',
          triggerType: 'event',
          cronExpression: '',
          eventFilters: [{ type: 'pr:create' }],
          config: { prompt: 'go', name: 'E', embedEventContext: true },
        }),
      ],
      ['evt-llm'],
      '2026-07-14T00:00:00.000Z',
    )
    const parsed = parseImportFile(serializeExportFile(file))
    if (!parsed.ok) throw new Error('expected ok')
    const result = mapToCreateInput(parsed.automations[0], opts)
    if (!result.importable) throw new Error('expected importable')
    expect((result.input.config as Record<string, unknown>).embedEventContext).toBe(true)
  })

  it('an old export without embedEventContext imports with the flag absent (off)', () => {
    const result = mapToCreateInput(
      { type: 'llm', vendor: 'claude', agentId: 'claude-1', config: { prompt: 'go' } },
      opts,
    )
    if (!result.importable) throw new Error('expected importable')
    expect('embedEventContext' in (result.input.config as Record<string, unknown>)).toBe(false)
  })
})
