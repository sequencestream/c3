/**
 * task-tracker — server-side task-list wire derivation (2026-06-07-009).
 *
 * Covers the two seams end-to-end through the real `emit()` registry:
 *  - live: a task tool_use/tool_result pair flowing through `emit()` produces a
 *    `task_list` snapshot on the wire (and into the replay buffer);
 *  - cold replay: `deriveTasksFromHistory` rebuilds the model from a baseline.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { ServerToClient, TranscriptItem } from '@ccc/shared/protocol'
import {
  addViewer,
  emit,
  ensureRuntime,
  getRuntime,
  removeRuntime,
  setTaskObserver,
} from '../../runs.js'
import { deriveTasksFromHistory, observeTaskWire } from './task-tracker.js'

// The observer is a module-level singleton; register the real one per suite and
// clear it after so other suites (e.g. runs.test.ts) are unaffected.
setTaskObserver(observeTaskWire)
afterEach(() => setTaskObserver(observeTaskWire))

/** The task_list events a viewer saw, newest last. */
function taskLists(events: ServerToClient[]): ServerToClient[] {
  return events.filter((e) => e.type === 'task_list')
}

describe('observeTaskWire (live derivation via emit)', () => {
  it('emits a task_list snapshot after a TaskList tool_use/tool_result pair', () => {
    ensureRuntime('tt-list', '/ws', 'default', [])
    const seen: ServerToClient[] = []
    addViewer('tt-list', (e) => seen.push(e))

    emit('tt-list', { type: 'tool_use', toolUseId: 'u1', toolName: 'TaskList', input: {} })
    // No task_list yet — the result hasn't arrived.
    expect(taskLists(seen)).toHaveLength(0)

    emit('tt-list', {
      type: 'tool_result',
      toolUseId: 'u1',
      // Raw JSON fixture (kernel/ bans JSON.stringify — ADR-0009 R2): mirrors the
      // SDK's serialized TaskList tool_result.
      content:
        '{"tasks":[{"id":"1","subject":"A","status":"in_progress"},{"id":"2","subject":"B","status":"pending"}]}',
      isError: false,
    })

    const lists = taskLists(seen)
    expect(lists).toHaveLength(1)
    const list = lists[0]
    if (list.type !== 'task_list') throw new Error('unreachable')
    expect(list.tasks.map((t) => [t.id, t.subject, t.status])).toEqual([
      ['1', 'A', 'in_progress'],
      ['2', 'B', 'pending'],
    ])
    removeRuntime('tt-list')
  })

  it('buffers the task_list so a later viewer replays it (ordered after tool_result)', () => {
    ensureRuntime('tt-buf', '/ws', 'default', [])
    emit('tt-buf', { type: 'tool_use', toolUseId: 'u1', toolName: 'TaskCreate', input: {} })
    emit('tt-buf', {
      type: 'tool_result',
      toolUseId: 'u1',
      content: '{"id":"7","subject":"New","status":"pending"}',
      isError: false,
    })

    const buffer = getRuntime('tt-buf')!.buffer
    const types = buffer.map((e) => e.type)
    // tool_use, tool_result, then the derived task_list right after it.
    expect(types).toEqual(['tool_use', 'tool_result', 'task_list'])
    const last = buffer[buffer.length - 1]
    if (last.type !== 'task_list') throw new Error('unreachable')
    expect(last.tasks.map((t) => t.id)).toEqual(['7'])
    removeRuntime('tt-buf')
  })

  it('does not emit task_list for non-task tools', () => {
    ensureRuntime('tt-skip', '/ws', 'default', [])
    const seen: ServerToClient[] = []
    addViewer('tt-skip', (e) => seen.push(e))
    emit('tt-skip', { type: 'tool_use', toolUseId: 'u1', toolName: 'Bash', input: {} })
    emit('tt-skip', { type: 'tool_result', toolUseId: 'u1', content: 'done', isError: false })
    expect(taskLists(seen)).toHaveLength(0)
    removeRuntime('tt-skip')
  })

  it('does not re-emit when the model is unchanged (unparseable TaskList keeps state)', () => {
    ensureRuntime('tt-same', '/ws', 'default', [])
    const seen: ServerToClient[] = []
    addViewer('tt-same', (e) => seen.push(e))
    // An unparseable TaskList result yields no change → no task_list (avoids
    // wrongly clearing the panel).
    emit('tt-same', { type: 'tool_use', toolUseId: 'u1', toolName: 'TaskList', input: {} })
    emit('tt-same', { type: 'tool_result', toolUseId: 'u1', content: 'not json', isError: false })
    expect(taskLists(seen)).toHaveLength(0)
    removeRuntime('tt-same')
  })

  it('tracks status changes (TaskUpdate) across calls', () => {
    ensureRuntime('tt-upd', '/ws', 'default', [])
    const seen: ServerToClient[] = []
    addViewer('tt-upd', (e) => seen.push(e))

    emit('tt-upd', { type: 'tool_use', toolUseId: 'a', toolName: 'TaskCreate', input: {} })
    emit('tt-upd', {
      type: 'tool_result',
      toolUseId: 'a',
      content: '{"id":"1","subject":"A","status":"pending"}',
      isError: false,
    })
    // TaskUpdate with no parseable result → falls back to input.taskId increment.
    emit('tt-upd', {
      type: 'tool_use',
      toolUseId: 'b',
      toolName: 'TaskUpdate',
      input: { taskId: '1', status: 'completed' },
    })
    emit('tt-upd', { type: 'tool_result', toolUseId: 'b', content: 'updated', isError: false })

    const lists = taskLists(seen)
    const latest = lists[lists.length - 1]
    if (latest.type !== 'task_list') throw new Error('unreachable')
    expect(latest.tasks.find((t) => t.id === '1')?.status).toBe('completed')
    removeRuntime('tt-upd')
  })
})

describe('deriveTasksFromHistory (cold replay)', () => {
  it('rebuilds the model from a baseline transcript', () => {
    const history: TranscriptItem[] = [
      { kind: 'user', text: 'do it' },
      { kind: 'tool_use', toolUseId: 'h1', toolName: 'TaskList', input: {} },
      {
        kind: 'tool_result',
        toolUseId: 'h1',
        content:
          '{"tasks":[{"id":"1","subject":"A","status":"completed"},{"id":"2","subject":"B","status":"in_progress"}]}',
        isError: false,
      },
    ]
    const model = deriveTasksFromHistory(history)
    expect(model.tasks.map((t) => [t.id, t.status])).toEqual([
      ['1', 'completed'],
      ['2', 'in_progress'],
    ])
  })

  it('ignores non-task tools and uncorrelated results', () => {
    const history: TranscriptItem[] = [
      { kind: 'tool_use', toolUseId: 'x', toolName: 'Bash', input: {} },
      { kind: 'tool_result', toolUseId: 'x', content: 'ok', isError: false },
      { kind: 'tool_result', toolUseId: 'orphan', content: '[]', isError: false },
    ]
    expect(deriveTasksFromHistory(history)).toEqual({ tasks: [] })
  })
})
