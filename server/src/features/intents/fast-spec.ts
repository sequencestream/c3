/**
 * Fast-spec turn settlement — the spec-later tail of per-intent `fast` mode.
 *
 * When a MANUAL work turn of a fast-mode intent (SDD on, effective mode `fast`)
 * settles, the run:settled handler calls {@link settleFastTurn}. It decides what
 * the turn's diff — measured against the git baseline captured at launch —
 * earned:
 *
 *  - no diff             → stay `fast`, record an observable "no change" outcome.
 *  - within the workspace thresholds (< max files AND < max lines, no binary) →
 *    reverse-author a PENDING spec document at the centralized spec root from
 *    the intent + the diff, so the human's `approve_spec` closes the SDD loop.
 *  - over the thresholds → keep every diff / working-tree product untouched,
 *    pin the intent to explicit `sdd`, and let the ordinary spec gate refuse the
 *    next resume/continue until a spec is authored, reviewed and approved.
 *
 * Only manual turns are handled: the automation queue still requires
 * `specStatus === 'approved'` regardless of mode, so an unattended run never
 * reaches this path. `attach` sends no new turn, and `sddEnabled=false`
 * performs no spec stage at all.
 *
 * The diff is always measured against the fixed turn-start baseline (persisted
 * at launch in `intent_fast_turns`), so committing the turn's changes during
 * settle — or a service restart — never moves the yardstick. The settlement is
 * idempotent per session: a replayed `run:settled` event or a concurrent handler
 * finds the turn already claimed and no-ops. Any unmeasurable condition
 * (baseline lost, diff unreadable, store unavailable) FAILS CLOSED to `sdd` —
 * an unmeasured diff is never classified as a small change.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Intent } from '@ccc/shared/protocol'
import {
  getFastSpecMaxFiles,
  getFastSpecMaxLines,
  getGitBranchMode,
  getSddEnabled,
} from '../../kernel/config/index.js'
import { gitHeadCommits, gitNumstat, gitUntracked } from '../../git.js'
import {
  claimFastTurnSettled,
  completeFastTurnSettle,
  getFastTurn,
  getIntent,
  safeInsertIntentLog,
  setReverseSpec,
  switchFastIntentToSdd,
  upsertFastTurnBaseline,
} from './store.js'
import { getSpecsBase } from './specs-root.js'
import { computeSpecLayout } from './spec-path.js'
import { getWorktreePath } from './worktree.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The dev directory an intent develops in: its worktree under `worktree` mode, else the workspace. */
function devDirFor(workspacePath: string, intentId: string): string {
  return getGitBranchMode(workspacePath) === 'worktree'
    ? getWorktreePath(workspacePath, intentId)
    : workspacePath
}

// ── Launch side: baseline capture ──

/**
 * Record the git baseline a manual fast-mode work turn is about to start from,
 * keyed by the work session id. Called right before the turn is launched (fresh
 * and resume alike). The settle later diffs against this fixed baseline. Failures
 * are logged and swallowed here — the settle's fail-closed-to-`sdd` rule is what
 * a missing baseline triggers.
 */
export async function captureFastTurnBaseline(
  workspacePath: string,
  sessionId: string,
  intentId: string,
): Promise<void> {
  try {
    const baseline = await gitHeadCommits(devDirFor(workspacePath, intentId))
    upsertFastTurnBaseline({ sessionId, intentId, workspacePath, baseline })
  } catch (err) {
    console.warn(`[c3:intents] fast-spec baseline capture failed for ${intentId}: ${errMsg(err)}`)
  }
}

// ── Settle side: diff measurement ──

/** Measured diff of one fast turn against its launch baseline. */
export interface TurnDiffStats {
  /** Distinct changed paths across every repo (rename counts its target once). */
  fileCount: number
  /** Additions + deletions across text changes; binary / unreadable files do not add here. */
  lines: number
  /** True when any changed path is binary (always classified as over-threshold). */
  hasBinary: boolean
  files: string[]
  /** Human-readable per-repo summary, embedded in the reverse spec. */
  diffText: string
}

/** Parse the persisted baseline JSON (repo → HEAD commit) defensively. */
export function parseBaseline(json: string): Record<string, string | null> {
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string | null>)
      : {}
  } catch {
    return {}
  }
}

/** Count a local file's lines and binary-ness (for untracked files git won't numstat). */
function localFileStats(repo: string, relPath: string): { lines: number; binary: boolean } {
  try {
    const buf = readFileSync(join(repo, relPath))
    // A NUL byte marks binary; an unreadable file is also treated as binary so
    // the conservative over-threshold rule applies.
    if (buf.includes(0)) return { lines: 0, binary: true }
    let n = 0
    for (const b of buf) if (b === 0x0a) n++
    return { lines: n, binary: false }
  } catch {
    return { lines: 0, binary: true }
  }
}

/**
 * Display prefix for a repo under the dev directory: its path relative to the
 * dev dir, or `''` when the repo IS the dev dir (single-repo path). Used to keep
 * changed-path keys and reverse-spec listing distinguishable across repos —
 * two repos may both carry `src/index.ts`, and a bare relative path would merge
 * them into one counted file.
 */
function repoPrefix(devDir: string, repo: string): string {
  if (repo === devDir) return ''
  return relative(devDir, repo).split(sep).join('/')
}

/**
 * Compute the turn's diff stats against its launch baseline, multi-repo aware.
 * With a baseline, `git diff --numstat <base>` covers EVERYTHING that changed
 * since it — turn commits AND uncommitted tracked edits — so the manual
 * cleanup's commit never moves the measurement; the un-ref'd form would RE-COUNT
 * the uncommitted tracked edits on top of that (inflating `lines`), so it is
 * used only when no baseline was recorded. Untracked files are added separately.
 */
export async function computeTurnDiff(
  devDir: string,
  baseline: Record<string, string | null>,
): Promise<TurnDiffStats> {
  const files = new Set<string>()
  let lines = 0
  let hasBinary = false
  const parts: string[] = []

  for (const [repo, base] of Object.entries(baseline)) {
    // One measurement, mutually exclusive by baseline availability: WITH a base
    // `diff --numstat <base>` covers everything since the baseline (turn commits
    // AND uncommitted tracked edits); WITHOUT one (baseline lost) the un-ref'd
    // form measures just the uncommitted tracked edits. Both add untracked files
    // separately — and the two diff forms are never both called, so nothing is
    // ever double-counted.
    const entries = base ? await gitNumstat(repo, base) : await gitNumstat(repo)
    const untracked = await gitUntracked(repo)
    // Multi-repo keying: the same relative path may exist in several repos (e.g.
    // two repos both carry `src/index.ts`). Dedupe on repo+path and keep a
    // readable repo prefix so `fileCount` counts DISTINCT changed files and the
    // reverse-spec listing stays attributable to its repo.
    const prefix = repoPrefix(devDir, repo)

    const repoLines: string[] = []
    for (const e of entries) {
      files.add(prefix ? `${prefix}/${e.path}` : e.path)
      if (e.binary) hasBinary = true
      else lines += e.additions + e.deletions
      repoLines.push(`${e.binary ? '-' : e.additions}\t${e.binary ? '-' : e.deletions}\t${e.path}`)
    }
    for (const u of untracked) {
      files.add(prefix ? `${prefix}/${u}` : u)
      const st = localFileStats(repo, u)
      if (st.binary) hasBinary = true
      else lines += st.lines
      repoLines.push(`+\t+\t${u} (untracked)`)
    }
    if (repoLines.length > 0) parts.push(`# ${prefix || repo}\n${repoLines.join('\n')}`)
  }

  return {
    fileCount: files.size,
    lines,
    hasBinary,
    files: [...files].sort(),
    diffText: parts.join('\n\n'),
  }
}

// ── Settle side: decision + reverse spec ──

/**
 * Build the reverse-authored spec document for a small fast turn. Deliberately a
 * deterministic draft (not an agent author): the change is already on disk, so
 * the document's job is to be a reviewable, traceable contract — the intent body
 * plus the turn's diff — that the human edits if needed and then approves. It is
 * real content, never the seed, so it may legitimately land as `pending`.
 */
export function buildReverseSpec(intent: Intent, stats: TurnDiffStats, nowIso: string): string {
  const filesBlock =
    stats.files.length > 0
      ? stats.files.map((f) => `- \`${f}\``).join('\n')
      : '_(no changed files)_'
  const diffBlock = stats.diffText ? `\`\`\`\n${stats.diffText}\n\`\`\`` : '_(no diff text)_'
  return `---
intent_id: ${intent.id}
title: ${intent.title}
created: ${nowIso}
origin: reverse-spec
---

# Spec: ${intent.title}

> Reverse-authored by c3 after a \`fast\`-mode development turn settled. This document
> retrospectively captures the change from the intent and the turn's diff. It is
> **pending human approval**: review it, edit it via the spec tab if needed, and
> approve it to close the SDD loop.

## Intent

${intent.content}

## Change summary

${stats.fileCount} file(s) changed, ${stats.lines} line(s) (additions + deletions).

Changed files:

${filesBlock}

## Diff

${diffBlock}

## Acceptance

Review the diff above against the intent body. Approve this spec only if the diff
satisfies the intent; otherwise revise the code or this document before approving.
`
}

/**
 * Write the reverse spec at the centralized spec root under the per-intent
 * canonical path, then record it on the intent as `pending` (clearing any stale
 * review / approval facts in the same statement). Returns the written path.
 */
export function writeReverseSpec(
  workspacePath: string,
  intent: Intent,
  stats: TurnDiffStats,
): string {
  const specRoot = getSpecsBase(workspacePath)
  const layout = computeSpecLayout({
    specRoot,
    shortEnTitle: intent.shortEnTitle,
    intentId: intent.id,
    now: new Date(),
    listDay: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
  })
  mkdirSync(layout.dirAbs, { recursive: true })
  writeFileSync(layout.fileAbs, buildReverseSpec(intent, stats, new Date().toISOString()), 'utf8')
  setReverseSpec(intent.id, layout.fileAbs)
  safeInsertIntentLog(intent.id, 'spec_created', 'fast 模式落定后反向生成 spec 草稿', 'system')
  return layout.fileAbs
}

/**
 * Settle one fast-mode work turn (called from the run:settled handler, manual
 * turns only). Idempotent per session; every failure path fails CLOSED to `sdd`
 * rather than classifying an unmeasured diff as small.
 */
export async function settleFastTurn(
  workspacePath: string,
  sessionId: string,
  intentId: string,
  deps: { broadcastIntents: (workspacePath: string) => void },
): Promise<void> {
  // Launch→settle handshake: a missing baseline means the launch never recorded
  // one (server restart between launch and settle, or a captured failure). Keep
  // the diff, pin the intent back to `sdd`, and never classify it as small.
  const turn = getFastTurn(sessionId)
  if (!turn) {
    if (switchFastIntentToSdd(intentId)) deps.broadcastIntents(workspacePath)
    return
  }
  // Idempotency: claim first; a replayed event / concurrent handler no-ops.
  if (!claimFastTurnSettled(sessionId)) return

  // Act on TODAY's facts: the intent may have been switched, or may already
  // carry a spec (a prior reverse-spec, or a user-authored one). Once a spec
  // exists this intent's reverse-spec lifecycle is done — never generate a
  // second document, never re-escalate.
  const current = getIntent(intentId)
  if (!current) return
  if (!getSddEnabled(workspacePath) || current.effectiveSpecMode !== 'fast') return
  if (current.specPath) {
    completeFastTurnSettle(sessionId, 'no_change', current.specPath)
    return
  }

  let stats: TurnDiffStats
  try {
    stats = await computeTurnDiff(devDirFor(workspacePath, intentId), parseBaseline(turn.baseline))
  } catch (err) {
    console.warn(`[c3:intents] fast-spec diff failed for ${intentId}: ${errMsg(err)}`)
    if (switchFastIntentToSdd(intentId)) deps.broadcastIntents(workspacePath)
    completeFastTurnSettle(sessionId, 'failed')
    return
  }

  if (stats.fileCount === 0) {
    completeFastTurnSettle(sessionId, 'no_change')
    return
  }

  // Strictly less-than semantics: reaching either bound is over. A binary change
  // is always over the line threshold.
  const maxFiles = getFastSpecMaxFiles(workspacePath)
  const maxLines = getFastSpecMaxLines(workspacePath)
  if (stats.fileCount >= maxFiles || stats.hasBinary || stats.lines >= maxLines) {
    // Over threshold: keep every diff / working-tree product untouched, pin the
    // intent to explicit `sdd`. The next resume/continue is refused by the
    // ordinary spec gate until a spec is authored, reviewed and approved.
    switchFastIntentToSdd(intentId)
    completeFastTurnSettle(sessionId, 'over')
    deps.broadcastIntents(workspacePath)
    return
  }

  // Small change: reverse-author a pending spec. A failure here never lands a
  // pending marker on nothing and never auto-approves — the diff is preserved,
  // the intent stays fast, and the recorded `failed` outcome makes it retriable /
  // diagnosable on the next turn.
  try {
    const specPath = writeReverseSpec(workspacePath, current, stats)
    completeFastTurnSettle(sessionId, 'small', specPath)
    deps.broadcastIntents(workspacePath)
  } catch (err) {
    console.warn(`[c3:intents] fast-spec generation failed for ${intentId}: ${errMsg(err)}`)
    completeFastTurnSettle(sessionId, 'failed')
  }
}
