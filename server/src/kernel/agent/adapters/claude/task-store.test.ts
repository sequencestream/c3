/**
 * ClaudeTaskStore behaviour (ADR-0011 TaskStore amendment). Hermetic: the SDK
 * executor is mocked, so no `claude` process spawns. Exercises the shadow-merge
 * logic, the input mapping to the SDK tool shapes, and the degradation rules
 * (parse-miss keeps the shadow; explicit not-found drops it).
 */
import { describe, it, expect, vi } from 'vitest'
import type { TaskToolName, TaskToolOutput } from '../../index.js'
import type { TaskStore } from '../types.js'
import { ClaudeTaskStore, type ClaudeTaskExecutor } from './task-store.js'

const ok = (content: string): TaskToolOutput => ({ content, isError: false })

/** A recording mock executor that returns a scripted output per tool name. */
function mockExec(responses: Partial<Record<TaskToolName, TaskToolOutput>>): {
  exec: ClaudeTaskExecutor
  calls: Array<{ tool: TaskToolName; input: unknown }>
} {
  const calls: Array<{ tool: TaskToolName; input: unknown }> = []
  const exec: ClaudeTaskExecutor = vi.fn(async (tool: TaskToolName, input: unknown) => {
    calls.push({ tool, input })
    return responses[tool] ?? ok('')
  })
  return { exec, calls }
}

describe('ClaudeTaskStore.create', () => {
  it('drives TaskCreate, returns the created task, and tracks it in the shadow', async () => {
    const { exec, calls } = mockExec({
      TaskCreate: ok('{"task":{"id":"1","subject":"echoed"}}'),
    })
    const store = new ClaudeTaskStore(exec)
    const task = await store.create('default', 'Fix login')
    expect(task).toEqual({ id: '1', subject: 'Fix login', status: 'pending' })
    // subject doubles as the SDK-required description; list name is not forwarded.
    expect(calls[0]).toEqual({
      tool: 'TaskCreate',
      input: { subject: 'Fix login', description: 'Fix login' },
    })
    // Tracked in the shadow ⇒ a later update can merge onto it.
    const updated = await store.update('1', { status: 'completed' })
    expect(updated.subject).toBe('Fix login')
  })

  it('does not shadow-track a task whose id could not be parsed', async () => {
    const { exec } = mockExec({ TaskCreate: ok('no id here') })
    const store = new ClaudeTaskStore(exec)
    const task = await store.create('default', 'subj')
    expect(task.id).toBe('')
    // Nothing tracked: an update for a never-seen id builds a fresh stub.
    const updated = await store.update('x', { subject: 'new' })
    expect(updated).toEqual({ id: 'x', subject: 'new', status: 'pending' })
  })
})

describe('ClaudeTaskStore.list', () => {
  it('replaces the shadow with a fresh snapshot', async () => {
    const { exec } = mockExec({
      TaskList: ok('{"tasks":[{"id":"1","subject":"a","status":"pending"}]}'),
    })
    const store = new ClaudeTaskStore(exec)
    expect(await store.list()).toEqual([{ id: '1', subject: 'a', status: 'pending' }])
  })

  it('keeps the existing shadow when a list output is unparseable (no wrongful clear)', async () => {
    const responses: Partial<Record<TaskToolName, TaskToolOutput>> = {
      TaskCreate: ok('{"task":{"id":"1","subject":"x"}}'),
      TaskList: ok('garbage not a list'),
    }
    const store = new ClaudeTaskStore(
      vi.fn(async (tool: TaskToolName) => responses[tool] ?? ok('')),
    )
    await store.create('default', 'Keep me')
    // Parse miss ⇒ shadow snapshot returned, not an empty list.
    expect(await store.list()).toEqual([{ id: '1', subject: 'Keep me', status: 'pending' }])
  })

  it('clears the shadow on a recognisably empty list', async () => {
    const responses: Partial<Record<TaskToolName, TaskToolOutput>> = {
      TaskCreate: ok('{"task":{"id":"1","subject":"x"}}'),
      TaskList: ok('{"tasks":[]}'),
    }
    const store = new ClaudeTaskStore(
      vi.fn(async (tool: TaskToolName) => responses[tool] ?? ok('')),
    )
    await store.create('default', 'Gone soon')
    expect(await store.list()).toEqual([])
  })
})

describe('ClaudeTaskStore.update', () => {
  it('maps the patch to SDK input edges and merges onto the shadow', async () => {
    const { exec, calls } = mockExec({
      TaskList: ok('{"tasks":[{"id":"1","subject":"a","status":"pending"}]}'),
      TaskUpdate: ok(
        '{"success":true,"taskId":"1","statusChange":{"from":"pending","to":"in_progress"}}',
      ),
    })
    const store = new ClaudeTaskStore(exec)
    await store.list() // seed the shadow
    const updated = await store.update('1', { owner: 'agent-2', blockedBy: ['9'] })
    // status comes from the SDK statusChange; subject preserved from the shadow.
    expect(updated).toEqual({
      id: '1',
      subject: 'a',
      status: 'in_progress',
      owner: 'agent-2',
      blockedBy: ['9'],
    })
    // blockedBy maps to the SDK's additive edge.
    expect(calls[1]).toEqual({
      tool: 'TaskUpdate',
      input: { taskId: '1', owner: 'agent-2', addBlockedBy: ['9'] },
    })
  })

  it('returns the optimistic merge even when the SDK reports failure', async () => {
    const { exec } = mockExec({ TaskUpdate: { content: '', isError: true } })
    const store = new ClaudeTaskStore(exec)
    const updated = await store.update('5', { status: 'completed', subject: 'done' })
    expect(updated).toEqual({ id: '5', subject: 'done', status: 'completed' })
  })
})

describe('ClaudeTaskStore.get', () => {
  it('returns and upserts a found task', async () => {
    const { exec } = mockExec({
      TaskGet: ok('{"task":{"id":"3","subject":"s","status":"completed"}}'),
    })
    const store = new ClaudeTaskStore(exec)
    expect(await store.get('3')).toEqual({ id: '3', subject: 's', status: 'completed' })
  })

  it('drops the task from the shadow and returns undefined on explicit not-found', async () => {
    const responses: Partial<Record<TaskToolName, TaskToolOutput>> = {
      TaskCreate: ok('{"task":{"id":"1","subject":"x"}}'),
      TaskGet: ok('{"task":null}'),
    }
    const store = new ClaudeTaskStore(
      vi.fn(async (tool: TaskToolName) => responses[tool] ?? ok('')),
    )
    await store.create('default', 'Doomed')
    expect(await store.get('1')).toBeUndefined()
    // Confirm it was removed: a list parse-miss now yields an empty shadow.
    responses.TaskList = ok('garbage')
    expect(await store.list()).toEqual([])
  })

  it('falls back to the shadow when the get output is unparseable', async () => {
    const responses: Partial<Record<TaskToolName, TaskToolOutput>> = {
      TaskCreate: ok('{"task":{"id":"1","subject":"x"}}'),
      TaskGet: ok('??? unparseable'),
    }
    const store = new ClaudeTaskStore(
      vi.fn(async (tool: TaskToolName) => responses[tool] ?? ok('')),
    )
    await store.create('default', 'Cached')
    expect(await store.get('1')).toEqual({ id: '1', subject: 'Cached', status: 'pending' })
  })

  it('returns undefined for an unknown id with no shadow entry', async () => {
    const { exec } = mockExec({ TaskGet: ok('??? unparseable') })
    const store = new ClaudeTaskStore(exec)
    expect(await store.get('nope')).toBeUndefined()
  })
})

describe('ClaudeTaskStore capability surface', () => {
  it('omits onUpdate (no native task-push event on the Claude SDK)', () => {
    const { exec } = mockExec({})
    const store: TaskStore = new ClaudeTaskStore(exec)
    expect(store.onUpdate).toBeUndefined()
  })
})
