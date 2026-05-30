import type { AnyConsensusOutcome, AskConsensusOutcome } from '@ccc/shared/protocol'

/**
 * AskUserQuestion helpers shared between App.vue (which seeds the answer draft
 * when a permission request arrives) and PermissionPrompt.vue (which renders the
 * per-question answer panel). Reading the tool input is loose and defensive: the
 * shape is whatever the model emitted.
 */

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestionView {
  index: number
  question: string
  header: string
  multiSelect: boolean
  options: AskOption[]
}

/** Read the questions out of an AskUserQuestion tool input (loose, defensive). */
export function askQuestionsOf(input: unknown): AskQuestionView[] {
  const qs = (input as { questions?: unknown })?.questions
  if (!Array.isArray(qs)) return []
  return qs.map((q, index) => {
    const o = q as Partial<AskQuestionView>
    return {
      index,
      question: typeof o.question === 'string' ? o.question : '',
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: (o as { multiSelect?: boolean }).multiSelect === true,
      options: Array.isArray(o.options)
        ? (o.options as AskOption[]).map((op) => ({
            label: String(op.label ?? ''),
            description: op.description,
          }))
        : [],
    }
  })
}

export function isAskConsensus(c: AnyConsensusOutcome | undefined): c is AskConsensusOutcome {
  return !!c && c.kind === 'ask'
}

/** The per-question roll-up for a given question index, when consensus is the ask shape. */
export function questionConsensus(c: AnyConsensusOutcome | undefined, qIndex: number) {
  return isAskConsensus(c) ? c.perQuestion.find((p) => p.index === qIndex) : undefined
}

/** Names (+reason) of voters who chose `label` for question `qIndex`. */
export function agentsForOption(c: AnyConsensusOutcome | undefined, qIndex: number, label: string) {
  const qc = questionConsensus(c, qIndex)
  if (!qc) return [] as { agentName: string; reason: string }[]
  return qc.answers
    .filter((a) => !a.abstain && a.optionLabels.includes(label))
    .map((a) => ({ agentName: a.agentName, reason: a.reason }))
}

/** Voters who answered question `qIndex` with a custom (non-option) reply. */
export function agentsForCustom(c: AnyConsensusOutcome | undefined, qIndex: number) {
  const qc = questionConsensus(c, qIndex)
  if (!qc) return [] as { agentName: string; custom: string; reason: string }[]
  return qc.answers
    .filter((a) => !a.abstain && a.optionLabels.length === 0 && a.custom)
    .map((a) => ({ agentName: a.agentName, custom: a.custom ?? '', reason: a.reason }))
}

/** Build the initial answer draft, pre-filling questions the agents agreed on. */
export function initAskDraft(input: unknown, consensus: AnyConsensusOutcome | undefined) {
  const draft: Record<number, { labels: string[]; custom: string }> = {}
  for (const q of askQuestionsOf(input)) {
    const qc = questionConsensus(consensus, q.index)
    const labels =
      qc && qc.unanimous && qc.agreed
        ? qc.agreed
            .split(',')
            .map((s) => s.trim())
            .filter((l) => q.options.some((o) => o.label === l))
        : []
    draft[q.index] = { labels, custom: '' }
  }
  return draft
}
