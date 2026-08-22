/**
 * Closed permission-request categories eligible for IM queue_respond contracts.
 */
import { createHash } from 'node:crypto'
import { askQuestions } from '../../consensus-tally.js'
import { normalizeToolRequest, NORMALIZATION_VERSION } from '../../kernel/permission/risk.js'
import type { TodoAnswerOption, VendorId } from '@ccc/shared/protocol'

export const IM_PERMISSION_CATEGORY_VERSION = 'v1'
export const IM_ASK_USER_QUESTION_CATEGORY = 'AskUserQuestion' as const

export type ImPermissionCategory = typeof IM_ASK_USER_QUESTION_CATEGORY

export interface ImPermissionCategoryMatch {
  category: ImPermissionCategory
  normalizationVersion: string
  inputFingerprint: string
  questionLabel: string
  answers: TodoAnswerOption[]
}

function fingerprintInput(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input ?? null), 'utf8')
    .digest('hex')
}

function slugId(label: string, index: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 24)
  return base || `opt_${index}`
}

/** Classify a live permission request for IM contract issuance. */
export function classifyImPermissionRequest(
  vendor: VendorId,
  toolName: string,
  input: unknown,
): ImPermissionCategoryMatch | null {
  if (toolName !== 'AskUserQuestion') return null
  const norm = normalizeToolRequest(vendor, toolName, input)
  if (!norm.ok || norm.risk.normalizationVersion !== NORMALIZATION_VERSION) return null
  const qs = askQuestions(input)
  if (!qs || qs.length !== 1) return null
  const q = qs[0]!
  if (q.multiSelect) return null
  const labels = q.options.map((o) => o.label.trim()).filter(Boolean)
  if (labels.length !== q.options.length) return null
  const uniq = new Set(labels)
  if (uniq.size !== labels.length) return null
  const answers: TodoAnswerOption[] = labels.map((label, i) => ({
    answerId: slugId(label, i),
    label,
  }))
  answers.push({ answerId: 'cancel', label: 'cancel' })
  return {
    category: IM_ASK_USER_QUESTION_CATEGORY,
    normalizationVersion: String(norm.risk.normalizationVersion),
    inputFingerprint: fingerprintInput(input),
    questionLabel: q.question,
    answers,
  }
}
