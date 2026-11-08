import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostDshHome } from '../../kernel/config/workspace-path.js'
import { loadHistoryForVendor } from './history.js'

const dirs: string[] = []
const savedC3Dir = process.env.C3_DIR

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = savedC3Dir
})

describe('loadHistoryForVendor dsh', () => {
  it('replays a persisted DSH log as transcript items', async () => {
    const workspace = '/work/project'
    const root = mkdtempSync(join(tmpdir(), 'c3-dsh-history-'))
    dirs.push(root)
    process.env.C3_DIR = root
    const dshHome = hostDshHome(workspace)
    const dir = join(dshHome, 'sessions', '-work-project', 'sess-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'session.v4.jsonl'),
      [
        '{"type":"session","version":4,"id":"sess-1","createdAt":1,"isSeeded":false,"delegationDepth":0}',
        '{"type":"user/message","seq":1,"time":10,"surfaceOp":"append","data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}',
        '{"type":"assistant/message","seq":2,"time":11,"surfaceOp":"append","data":{"message":{"content":[{"type":"text","text":"hi"}]}}}',
        '{"type":"tool/call","seq":3,"time":12,"data":{"callId":"call_00","name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}',
        '{"type":"tool/result","seq":4,"time":13,"surfaceOp":"append","data":{"message":{"toolCallId":"call_00","isError":false,"content":[{"type":"text","text":"body"}]}}}',
        '',
      ].join('\n'),
    )

    const items = await loadHistoryForVendor('dsh', workspace, 'sess-1')

    expect(items).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi' },
      { kind: 'tool_use', toolUseId: 'dsh-3', toolName: 'read', input: { path: 'a.ts' } },
      { kind: 'tool_result', toolUseId: 'dsh-3', content: 'body', isError: false },
    ])
  })
})
