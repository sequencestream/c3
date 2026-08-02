/**
 * `save_intents` upsert of an EXISTING intent must not silently inherit the spec
 * approval that was granted for the old requirement text. Interactive saves carry
 * no server-side confirmation dialog, so the ledger itself holds the invariant:
 * a title/content rewrite revokes the approval (and vetoes the review conclusion
 * it rested on), which puts the intent back in front of a human before any
 * automated development session can consume the rewritten text.
 *
 * Covered here against the real store + the real queue kernel:
 *  - rewrite → approval cleared, approver cleared, exactly one `spec_unapproved`;
 *  - metadata-only edits (priority / module / shortEnTitle / deps) → approval intact;
 *  - batch atomicity: an invalid sibling rejects the batch, approval untouched;
 *  - the `runSaveConfirmed` save path broadcasts the already-unapproved snapshot;
 *  - queue admission: the rewritten intent produces no `launch`, and — with machine
 *    approval on and the spec FILE unchanged — no `machine_approve_spec` either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Intent } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { reconcileQueue } from '../../kernel/queue/reconcile.js'
import type { QueueIntentFact, QueueReconcileInput } from '../../kernel/queue/types.js'
import {
  clearSpecReviewMachineBlock,
  getIntent,
  insertIntents,
  listIntentLogs,
  listIntents,
  recordSpecReview,
  resetStoreForTests,
  setAutomate,
  setSpecApproved,
  setSpecPath,
  updateStatus,
  upsertIntents,
} from './store.js'
import { runSaveConfirmed } from './tool-defs.js'

const proj = '/abs/upsert-approval-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-upsert-approval-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

const FP = 'fingerprint-of-the-approved-spec'

/** An approved, queued intent: spec written, reviewed `pass`, approved, automated. */
function seedApproved(over: { title?: string; content?: string } = {}): Intent {
  const [r] = insertIntents(proj, [
    {
      title: over.title ?? '原始标题',
      shortEnTitle: 'orig',
      content: over.content ?? '原始正文',
      priority: 'P1',
      module: 'auth',
    },
  ])
  setSpecPath(r.id, '2026/08/02/2026-08-02-001-orig.md')
  recordSpecReview({
    intentId: r.id,
    sessionId: 'review-1',
    verdict: 'pass',
    reason: '符合要求',
    fingerprint: FP,
    liveFingerprint: FP,
  })
  setSpecApproved(r.id, true, 'alice')
  setAutomate(r.id, true)
  return getIntent(r.id)!
}

function logsOf(intentId: string, op: string) {
  return listIntentLogs(intentId).filter((l) => l.operationType === op)
}

describe('upsertIntents — 改写既有意图的标题/正文即撤销 spec 批准', () => {
  it('改写 content:清除批准与批准人,并恰好追加一条 spec_unapproved', () => {
    const r = seedApproved()
    upsertIntents(
      proj,
      [{ id: r.id, title: r.title, shortEnTitle: 'orig', content: '被改写的正文', priority: 'P1' }],
      'bob',
    )

    const after = getIntent(r.id)!
    expect(after.content).toBe('被改写的正文')
    expect(after.specApproved).toBe(false)
    expect(after.specApproveUser).toBeNull()
    expect(logsOf(r.id, 'spec_unapproved')).toMatchObject([
      { summary: '意图标题/正文被更新后撤销 spec 批准', actor: 'bob' },
    ])
    // 生命周期日志照旧保留,撤销是额外的、可辨识的安全审计事件。
    expect(logsOf(r.id, 'intent_updated')).toHaveLength(1)
  })

  it('仅改写 title:同样撤销批准', () => {
    const r = seedApproved()
    upsertIntents(proj, [
      { id: r.id, title: '被改写的标题', shortEnTitle: 'orig', content: r.content, priority: 'P1' },
    ])

    const after = getIntent(r.id)!
    expect(after.title).toBe('被改写的标题')
    expect(after.specApproved).toBe(false)
    expect(after.specApproveUser).toBeNull()
    expect(logsOf(r.id, 'spec_unapproved')).toHaveLength(1)
  })

  it('撤销同时否决旧审核结论,使机器批准不能把它直接批回来', () => {
    const r = seedApproved()
    expect(r.specReviewMachineApprovalBlocked).toBe(false)
    upsertIntents(proj, [
      { id: r.id, title: r.title, shortEnTitle: 'orig', content: '被改写的正文', priority: 'P1' },
    ])
    const after = getIntent(r.id)!
    // spec 文件未变 → 旧 `pass` 结论仍与指纹相符,只有这道否决拦得住它。
    expect(after.specReviewVerdict).toBe('pass')
    expect(after.specReviewFingerprint).toBe(FP)
    expect(after.specReviewMachineApprovalBlocked).toBe(true)
  })

  it('未批准的意图被改写:保持未批准,不制造撤销日志', () => {
    const [r] = insertIntents(proj, [
      { title: 't', shortEnTitle: 't', content: '原始正文', priority: 'P2' },
    ])
    upsertIntents(proj, [
      { id: r.id, title: 't', shortEnTitle: 't', content: '新正文', priority: 'P2' },
    ])
    const after = getIntent(r.id)!
    expect(after.specApproved).toBe(false)
    expect(logsOf(r.id, 'spec_unapproved')).toHaveLength(0)
  })

  it('actor 缺省时撤销日志记为 system', () => {
    const r = seedApproved()
    upsertIntents(proj, [
      { id: r.id, title: r.title, shortEnTitle: 'orig', content: '新正文', priority: 'P1' },
    ])
    expect(logsOf(r.id, 'spec_unapproved')[0].actor).toBe('system')
  })
})

describe('upsertIntents — 非需求正文变化不误伤批准', () => {
  it('仅改 priority / module:批准与批准人原样保留', () => {
    const r = seedApproved()
    upsertIntents(proj, [
      {
        id: r.id,
        title: r.title,
        shortEnTitle: 'orig',
        content: r.content,
        priority: 'P0',
        module: 'billing',
      },
    ])
    const after = getIntent(r.id)!
    expect(after.priority).toBe('P0')
    expect(after.module).toBe('billing')
    expect(after.specApproved).toBe(true)
    expect(after.specApproveUser).toBe('alice')
    expect(after.specReviewMachineApprovalBlocked).toBe(false)
    expect(logsOf(r.id, 'spec_unapproved')).toHaveLength(0)
  })

  it('仅改 shortEnTitle / 依赖:批准保留', () => {
    const r = seedApproved()
    upsertIntents(proj, [
      {
        id: r.id,
        title: r.title,
        shortEnTitle: 'renamed-branch-slug',
        content: r.content,
        priority: 'P1',
        dependsOn: ['ext-1'],
      },
    ])
    const after = getIntent(r.id)!
    expect(after.shortEnTitle).toBe('renamed-branch-slug')
    expect(after.dependsOn).toEqual(['ext-1'])
    expect(after.specApproved).toBe(true)
    expect(logsOf(r.id, 'spec_unapproved')).toHaveLength(0)
  })

  it('cancelled 重新激活但正文未变:批准保留', () => {
    const r = seedApproved()
    updateStatus(r.id, 'cancelled')
    upsertIntents(proj, [
      { id: r.id, title: r.title, shortEnTitle: 'orig', content: r.content, priority: 'P1' },
    ])
    const after = getIntent(r.id)!
    expect(after.status).toBe('todo')
    expect(after.specApproved).toBe(true)
    expect(logsOf(r.id, 'spec_unapproved')).toHaveLength(0)
  })

  it('纯新建(无 id)路径行为不变,且不触碰同项目已批准的意图', () => {
    const r = seedApproved()
    const out = upsertIntents(proj, [
      { title: '新意图', shortEnTitle: 'fresh', content: '新正文', priority: 'P0' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).not.toBe(r.id)
    expect(out[0].status).toBe('todo')
    expect(out[0].specApproved).toBe(false)
    expect(logsOf(out[0].id, 'spec_unapproved')).toHaveLength(0)
    const untouched = getIntent(r.id)!
    expect(untouched.specApproved).toBe(true)
    expect(untouched.specApproveUser).toBe('alice')
    expect(untouched.content).toBe(r.content)
  })
})

describe('upsertIntents — 撤销与更新共同提交或共同回滚', () => {
  it('批内有非法条目时整批拒绝:正文、批准、批准人与日志均保持原样', () => {
    const r = seedApproved()
    expect(() =>
      upsertIntents(proj, [
        { id: r.id, title: r.title, shortEnTitle: 'orig', content: '被改写的正文', priority: 'P1' },
        // 下标越界的兄弟条目 → 整批校验失败
        {
          title: 'sibling',
          shortEnTitle: 'sib',
          content: '',
          priority: 'P0',
          dependsOnIndexes: [5],
        },
      ]),
    ).toThrow()

    const after = getIntent(r.id)!
    expect(after.content).toBe(r.content)
    expect(after.specApproved).toBe(true)
    expect(after.specApproveUser).toBe('alice')
    expect(after.specReviewMachineApprovalBlocked).toBe(false)
    expect(logsOf(r.id, 'spec_unapproved')).toHaveLength(0)
    expect(listIntents(proj)).toHaveLength(1) // sibling 未落库
  })

  it('in_progress 目标仍不可修改,批准不受影响', () => {
    const r = seedApproved()
    updateStatus(r.id, 'in_progress')
    expect(() =>
      upsertIntents(proj, [
        { id: r.id, title: r.title, shortEnTitle: 'orig', content: '注入正文', priority: 'P1' },
      ]),
    ).toThrow(/不可修改/)
    const after = getIntent(r.id)!
    expect(after.content).toBe(r.content)
    expect(after.specApproved).toBe(true)
  })
})

describe('runSaveConfirmed — 保存路径广播未批准快照', () => {
  it('改写成功后按既有机制广播一次,库中已是未批准', () => {
    const r = seedApproved()
    const onSaved = vi.fn()
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          {
            id: r.id,
            title: r.title,
            shortEnTitle: 'orig',
            content: '被改写的正文',
            priority: 'P1',
          },
        ],
      },
      onSaved,
      'bob',
    )

    expect(res.isError).toBeFalsy()
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith(proj)
    // 广播的数据源是库:广播时刻批准已被清除,客户端不会看到"新正文 + 旧批准"。
    const [snapshot] = listIntents(proj)
    expect(snapshot.content).toBe('被改写的正文')
    expect(snapshot.specApproved).toBe(false)
    expect(snapshot.specApproveUser).toBeNull()
  })

  it('保存失败时不广播,也不撤销批准', () => {
    const r = seedApproved()
    updateStatus(r.id, 'in_progress')
    const onSaved = vi.fn()
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          { id: r.id, title: r.title, shortEnTitle: 'orig', content: '注入正文', priority: 'P1' },
        ],
      },
      onSaved,
      'bob',
    )

    expect(res.isError).toBe(true)
    expect(onSaved).not.toHaveBeenCalled()
    expect(getIntent(r.id)!.specApproved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Queue admission — the ledger state above, fed to the real scheduling kernel.
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000

/** Project a stored intent onto the kernel fact shape (mirrors workflow.ts#toFact). */
function toFact(r: Intent, specFingerprint: string | null): QueueIntentFact {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    automate: r.automate,
    dependsOn: r.dependsOn,
    specApproved: r.specApproved,
    prStatus: r.prStatus,
    lastWorkSessionId: r.lastWorkSessionId,
    createdAt: r.createdAt,
    specPath: r.specPath,
    specSessionId: r.specSessionId,
    specReviewSessionId: r.specReviewSessionId,
    specFingerprint,
    specReviewVerdict: r.specReviewVerdict,
    specReviewFingerprint: r.specReviewFingerprint,
    specReviewReworkRounds: r.specReviewReworkRounds,
    specReviewMachineApprovalBlocked: r.specReviewMachineApprovalBlocked,
  }
}

function reconcileFor(intentId: string, over: Partial<QueueReconcileInput> = {}) {
  const fact = toFact(getIntent(intentId)!, FP)
  return reconcileQueue({
    now: NOW,
    tickId: 'tick-1',
    workspacePath: proj,
    control: { state: 'running', startedAt: NOW - 1000, forceSkipped: [] },
    snapshotOk: true,
    intents: [fact],
    runs: [],
    meta: {},
    inFlight: [],
    gitBranchMode: 'current-branch',
    sddEnabled: true,
    machineApprovalEnabled: false,
    specRuns: [],
    specInFlight: [],
    ...over,
  })
}

const launchOf = (out: ReturnType<typeof reconcileQueue>) =>
  out.actions.find((a) => a.kind === 'launch' || a.kind === 'resume') ?? null

describe('队列准入 — 被改写的排队意图不得直接进入开发', () => {
  it('改写前可启动;改写正文后本轮不产生 launch,回到等待批准', () => {
    const r = seedApproved()
    // 基线:批准状态下队列会选中它。
    expect(launchOf(reconcileFor(r.id))).toMatchObject({ kind: 'launch', intentId: r.id })

    upsertIntents(proj, [
      { id: r.id, title: r.title, shortEnTitle: 'orig', content: '注入的开发指令', priority: 'P1' },
    ])

    const out = reconcileFor(r.id)
    expect(launchOf(out)).toBeNull()
    // 未批准的准入闸门先命中,规格阶段再把它细化为"等待人工批准"。
    const decision = out.decisions.find((d) => d.intentId === r.id)!
    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('spec_awaiting_approval')
  })

  it('机器批准开启时也不会把它直接批回来(spec 文件未变、旧结论仍匹配)', () => {
    const r = seedApproved()
    upsertIntents(proj, [
      { id: r.id, title: r.title, shortEnTitle: 'orig', content: '注入的开发指令', priority: 'P1' },
    ])

    const out = reconcileFor(r.id, { machineApprovalEnabled: true })
    expect(launchOf(out)).toBeNull()
    expect(out.actions.find((a) => a.kind === 'machine_approve_spec')).toBeUndefined()
  })

  it('持续不可启动,直到人工重新批准', () => {
    const r = seedApproved()
    upsertIntents(proj, [
      { id: r.id, title: r.title, shortEnTitle: 'orig', content: '注入的开发指令', priority: 'P1' },
    ])
    expect(launchOf(reconcileFor(r.id))).toBeNull()
    expect(launchOf(reconcileFor(r.id))).toBeNull() // 下一个 tick 仍然不启动

    // 人工重新批准(与 approve 处理器同一组写入)后才恢复准入。
    setSpecApproved(r.id, true, 'alice')
    clearSpecReviewMachineBlock(r.id)
    expect(launchOf(reconcileFor(r.id))).toMatchObject({ kind: 'launch', intentId: r.id })
  })
})
