/**
 * CursorSessionStore tests.
 *
 * Listing is exercised against a real chat-directory tree under a temporary home,
 * because the layout — the workspace-hash directory and the `meta.json` fields —
 * IS the contract with Cursor's own store. Replay is exercised through the source
 * seam, where a scripted transcript keeps the message-shape assertions readable.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CursorSessionStore,
  cursorWorkspaceHash,
  type CursorChatMeta,
  type CursorSessionSource,
} from './session-store.js'
import type { CursorStoredMessage } from './store-db.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(os.tmpdir(), 'c3-cursor-store-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

/**
 * Lay down one chat the way Cursor does. Raw JSON text rather than a serializer:
 * the fixture is the on-disk contract, so it is written as the file literally is.
 */
function writeChat(
  chatId: string,
  cwd: string,
  over: { title?: string; updatedAtMs?: number; hash?: string } = {},
): void {
  const hash = over.hash ?? createHash('md5').update(cwd).digest('hex')
  const dir = join(home, '.cursor', 'chats', hash, chatId)
  mkdirSync(dir, { recursive: true })
  const title = over.title ?? 'Some Chat'
  const updated = over.updatedAtMs ?? Date.now()
  writeFileSync(
    join(dir, 'meta.json'),
    `{"schemaVersion":1,"createdAtMs":${updated},"hasConversation":true,"title":"${title}","updatedAtMs":${updated},"cwd":"${cwd}"}`,
    'utf-8',
  )
}

function fakeSource(
  chats: CursorChatMeta[],
  transcript: CursorStoredMessage[],
): CursorSessionSource {
  return { chats: () => chats, transcript: () => transcript }
}

const CHAT: CursorChatMeta = {
  chatId: 'chat-1',
  dir: '/nowhere',
  cwd: '/ws',
  title: 'Some Chat',
  updatedAtMs: 1,
}

describe('listing the on-disk chat store', () => {
  it('finds a workspace’s chats through the hash directory', async () => {
    writeChat('chat-a', '/ws/project', { title: 'First' })
    const store = new CursorSessionStore()

    const listed = await store.list({ cwd: '/ws/project' })

    expect(listed).toMatchObject([{ sessionId: 'chat-a', title: 'First' }])
    expect(listed[0]?.vendorExtra).toMatchObject({ cwd: '/ws/project' })
  })

  it('finds a chat whose directory hash does not match, by its recorded cwd', async () => {
    // The hash is a fast path, not the truth: a store written under a different
    // canonicalization of the same path must still be found.
    writeChat('chat-b', '/ws/project', { hash: 'not-the-hash-of-this-path' })
    const store = new CursorSessionStore()

    await expect(store.list({ cwd: '/ws/project' })).resolves.toMatchObject([
      { sessionId: 'chat-b' },
    ])
  })

  it('lists most-recent first and excludes other workspaces', async () => {
    writeChat('older', '/ws/project', { title: 'Older', updatedAtMs: 1_000 })
    writeChat('newer', '/ws/project', { title: 'Newer', updatedAtMs: 2_000 })
    writeChat('elsewhere', '/ws/other', { title: 'Elsewhere' })
    const store = new CursorSessionStore()

    const listed = await store.list({ cwd: '/ws/project' })

    expect(listed.map((s) => s.sessionId)).toEqual(['newer', 'older'])
  })

  it('skips an unreadable chat rather than failing the whole listing', async () => {
    writeChat('good', '/ws/project', { title: 'Good' })
    const broken = join(home, '.cursor', 'chats', cursorWorkspaceHash('/ws/project'), 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'meta.json'), '{ not json', 'utf-8')
    const store = new CursorSessionStore()

    await expect(store.list({ cwd: '/ws/project' })).resolves.toMatchObject([{ sessionId: 'good' }])
  })

  it('returns nothing when the store does not exist, instead of throwing', async () => {
    const store = new CursorSessionStore()
    await expect(store.list({ cwd: '/ws/never-used' })).resolves.toEqual([])
  })
})

describe('replaying a stored transcript', () => {
  it('keeps the prompt and reply in order and drops the harness prompt', async () => {
    const store = new CursorSessionStore(
      fakeSource(
        [CHAT],
        [
          { role: 'system', content: 'You are an AI coding assistant.' },
          { role: 'user', content: [{ type: 'text', text: 'do it' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        ],
      ),
    )

    const messages = await store.read('chat-1', { cwd: '/ws' })

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.blocks[0]).toMatchObject({ type: 'text', text: 'done' })
  })

  it('translates reasoning into a thinking block, never inferring it from prose', async () => {
    const store = new CursorSessionStore(
      fakeSource([CHAT], [{ role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] }]),
    )

    const [message] = await store.read('chat-1', { cwd: '/ws' })
    expect(message?.blocks[0]).toMatchObject({ type: 'thinking', thinking: 'hmm' })
  })

  it('fills a tool result onto the call it answers, by native call id', async () => {
    const store = new CursorSessionStore(
      fakeSource(
        [CHAT],
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-7',
                toolName: 'Shell',
                args: { command: 'ls' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool-result', toolCallId: 'call-7', toolName: 'Shell', result: 'a\nb' },
            ],
          },
        ],
      ),
    )

    const [message] = await store.read('chat-1', { cwd: '/ws' })

    expect(message?.blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'call-7',
      name: 'Shell',
      input: { command: 'ls' },
      result: { content: 'a\nb', isError: false },
    })
    // Every tool in a stored transcript already ran under the launch-time gate.
    expect(message?.preApproved).toBe(true)
  })

  it('drops the environment context the harness injects into the user turn', async () => {
    // It arrives as a plain string rather than a block list, and opening the
    // transcript with a wall of machine-generated text buries the conversation.
    const store = new CursorSessionStore(
      fakeSource(
        [CHAT],
        [
          { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' },
          { role: 'user', content: 'the real question' },
        ],
      ),
    )

    const messages = await store.read('chat-1', { cwd: '/ws' })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.blocks[0]).toMatchObject({ text: 'the real question' })
  })

  it('returns nothing for a session this workspace does not have', async () => {
    const store = new CursorSessionStore(fakeSource([CHAT], []))
    await expect(store.read('other-chat', { cwd: '/ws' })).resolves.toEqual([])
  })
})
