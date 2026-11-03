#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertIsolatedSettings } from './settings-guard.mjs'

const url = process.argv[2] ?? 'ws://localhost:13000/ws'
const dbPath = await assertIsolatedSettings(url, {
  testScript: 'scripts/e2e/e2e-global-browser-test.mjs',
})
const ws = new WebSocket(url)
const pending = new Set()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  for (const waiter of pending)
    if (waiter.match(message)) {
      pending.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
})
function request(message, match) {
  return new Promise((resolve, reject) => {
    const waiter = {
      match,
      resolve,
      timer: setTimeout(() => {
        pending.delete(waiter)
        reject(new Error(`Timeout: ${message.type}`))
      }, 15000),
    }
    pending.add(waiter)
    ws.send(JSON.stringify(message))
  })
}
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
const root = mkdtempSync(join(tmpdir(), 'c3-global-test-'))
const names = ['global-alpha', 'global-beta'].map((name) => `${name}-${Date.now()}`)
const db = new DatabaseSync(dbPath)
try {
  for (const name of names) {
    const path = join(root, name)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path)
    await request(
      { type: 'add_workspace', workspaceName: name, path },
      (m) => m.type === 'workspaces' && m.workspaces.some((w) => w.name === name),
    )
    await request(
      { type: 'list_sessions', workspaceName: name },
      (m) => m.type === 'sessions' && m.workspaceName === name,
    )
  }
  const stamp = Date.now()
  const insert = db.prepare(
    `INSERT INTO session_metadata(c3_id,workspace_name,vendor,vendor_session_id,agent_id,title,last_modified,state,state_updated_at,kind,session_kind,bound) VALUES(?,?,?,?,?,?,?,'alive',?,'real',?,1)`,
  )
  for (let i = 1; i <= 45; i++) {
    const id = `global-e2e-${String(i).padStart(3, '0')}`
    insert.run(
      `claude:${id}`,
      names[i % 2],
      'claude',
      id,
      'test',
      `Global session ${i}`,
      stamp,
      stamp,
      i % 3 === 0 ? 'spec' : 'work',
    )
  }
  const seen = []
  let before
  let limit = 20
  for (let page = 0; page < 4; page++) {
    const replies = await Promise.all(
      names.map((workspaceName) => {
        const globalRequestId = `global-e2e-${page}-${workspaceName}`
        return request(
          { type: 'list_sessions', workspaceName, globalRequestId, before, limit },
          (m) => m.type === 'sessions' && m.globalRequestId === globalRequestId,
        )
      }),
    )
    const rows = replies
      .flatMap((reply) =>
        reply.sessions.map((row) => ({ ...row, workspaceName: reply.workspaceName })),
      )
      .sort((a, b) => b.lastModified - a.lastModified || (a.sessionId < b.sessionId ? 1 : -1))
      .slice(0, limit)
    assert.equal(rows.length, page === 0 ? 20 : page === 3 ? 5 : 10)
    seen.push(...rows.map((row) => row.sessionId))
    const last = rows.at(-1)
    before = {
      lastModified: last.lastModified,
      sessionId: last.sessionId,
      workspaceName: last.workspaceName,
    }
    limit = 10
  }
  assert.equal(new Set(seen).size, 45)
  for (const workspaceName of names) {
    const input = {
      type: 'command',
      config: { command: 'echo global-browser-test' },
      workspaceName,
      vendor: 'claude',
      cronExpression: '0 0 1 1 *',
      mode: 'default',
      initialStatus: 'paused',
      initialName: `Global automation ${workspaceName}`,
    }
    const list = await request(
      { type: 'create_automation', workspaceName, input },
      (m) => m.type === 'automations' && m.workspaceName === workspaceName && m.items.length > 0,
    )
    const automation = list.items[0]
    const detail = await request(
      { type: 'get_automation_detail', automationId: automation.id },
      (m) => m.type === 'automation_detail' && m.automation.id === automation.id,
    )
    assert.equal(detail.automation.workspaceName, workspaceName)
    assert.equal(detail.automation.status, 'paused')
  }
  console.log(
    'RESULT: PASS — mixed-kind global pagination 20/10/10/5; equal timestamps; automation details retain workspace ownership',
  )
} finally {
  if (!process.env.C3_KEEP_GLOBAL_FIXTURES) {
    for (const workspaceName of names) {
      await request(
        { type: 'remove_workspace', workspaceName },
        (m) => m.type === 'workspaces' && !m.workspaces.some((w) => w.name === workspaceName),
      )
    }
    rmSync(root, { recursive: true, force: true })
  }
  db.close()
  ws.close()
}
