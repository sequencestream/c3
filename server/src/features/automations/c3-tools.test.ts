/**
 * Business-logic tests for the automation c3 tool builder, driven DIRECTLY through
 * `buildAutomationC3Tools(...)` handlers (no SDK MCP wrapper). Two contracts unique
 * to the automation surface:
 *  - the `save_intent_directly` handler lands a batch of NEW intents as `draft`
 *    (not `todo`), bypassing the confirmation gate (it just writes), and fires the
 *    injected `broadcastIntents` so the list refreshes;
 *  - the `publish_event` handler seeds the execution's own metadata into the
 *    published event, with the model-supplied metadata winning on key conflicts.
 *
 * The tool-set boundary (which tools the automation surface advertises) is covered
 * by transport/automation-mcp/index.test.ts via a real MCP client; the discussion
 * run handlers by discussions/tool-defs.test.ts. Neither is repeated here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Identity id↔path mapping: synthetic test workspaces are unregistered.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { listIntents, resetStoreForTests } from '../../features/intents/store.js'
import { buildAutomationC3Tools, type AutomationMcpDeps } from './c3-tools.js'

const proj = '/abs/c3-tools-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-tools-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Base deps; an echoing normalizeEvent lets us inspect the merged metadata. */
function echoDeps(
  sink: GenericEventEnvelope[],
  broadcastIntents: (p: string) => void = () => {},
): AutomationMcpDeps {
  return {
    broadcastIntents,
    normalizeEvent: (core: GenericEvent) => ({ ok: true, event: core }),
    publishEvent: (p) => sink.push(p),
    broadcastDiscussions: () => {},
    broadcastDiscussionMessage: () => {},
    startDiscussionRun: () => {},
    launchRun: vi.fn().mockResolvedValue(undefined),
  }
}

/** Grab one tool's handler from a freshly built automation tool list. */
function handlerFor(toolName: string, deps: AutomationMcpDeps, metadata?: Record<string, string>) {
  const tool = buildAutomationC3Tools(proj, 'exec-1', deps, metadata).find(
    (t) => t.name === toolName,
  )
  if (!tool) throw new Error(`no automation tool named ${toolName}`)
  return tool.handler
}

describe('save_intent_directly handler', () => {
  it('lands new intents as draft (gate-free) and fires broadcastIntents', async () => {
    let saved: string | null = null
    const handler = handlerFor(
      'save_intent_directly',
      echoDeps([], (p) => (saved = p)),
    )
    const res = await handler({
      intents: [
        {
          title: 'Refactor god-file',
          shortEnTitle: 'refactor-god-file',
          content: 'x',
          priority: 'P2',
        },
        {
          title: 'Break cyclic dep',
          shortEnTitle: 'break-cyclic-dep',
          content: 'y',
          priority: 'P3',
        },
      ],
    })
    expect(res.isError).toBeFalsy()
    expect(saved).toBe(proj)
    const rows = listIntents(proj)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'draft')).toBe(true)
  })
})

describe('publish_event metadata seeding', () => {
  it("seeds the automation's own metadata into the published event", async () => {
    const published: GenericEventEnvelope[] = []
    const handler = handlerFor('publish_event', echoDeps(published), {
      source: 'auto',
      run: 'nightly',
    })
    const res = await handler({ type: 'custom:done', metadata: { extra: 'x' } })
    expect(res.isError).toBeFalsy()
    expect(published).toHaveLength(1)
    expect(published[0].event.metadata).toEqual({ source: 'auto', run: 'nightly', extra: 'x' })
  })

  it('lets the model-supplied metadata win on key conflicts', async () => {
    const published: GenericEventEnvelope[] = []
    const handler = handlerFor('publish_event', echoDeps(published), {
      run: 'nightly',
      source: 'auto',
    })
    const res = await handler({ type: 'custom:done', metadata: { run: 'override' } })
    expect(res.isError).toBeFalsy()
    expect(published[0].event.metadata).toEqual({ run: 'override', source: 'auto' })
  })

  it('uses only the automation metadata when the model supplies none', async () => {
    const published: GenericEventEnvelope[] = []
    const handler = handlerFor('publish_event', echoDeps(published), { source: 'auto' })
    const res = await handler({ type: 'custom:done' })
    expect(res.isError).toBeFalsy()
    expect(published[0].event.metadata).toEqual({ source: 'auto' })
  })

  it('leaves the event untouched when the automation has no metadata', async () => {
    const published: GenericEventEnvelope[] = []
    const handler = handlerFor('publish_event', echoDeps(published))
    const res = await handler({ type: 'custom:done', metadata: { extra: 'x' } })
    expect(res.isError).toBeFalsy()
    expect(published[0].event.metadata).toEqual({ extra: 'x' })
  })

  it('tags the envelope with the bound workspace + execution id', async () => {
    const published: GenericEventEnvelope[] = []
    const handler = handlerFor('publish_event', echoDeps(published))
    await handler({ type: 'custom:done' })
    expect(published[0].workspacePath).toBe(proj)
    expect(published[0].sessionId).toBe('exec-1')
  })
})
