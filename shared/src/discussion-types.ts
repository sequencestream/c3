/**
 * Data-driven discussion type catalog + per-type workflow.
 *
 * A discussion's *type* decides how its organizer drives it: every type carries an
 * ordered `workflow` of stages telling the organizer WHEN to keep the floor open,
 * WHEN to summarize, WHEN to confirm with the parties, and WHEN to draw the final
 * conclusion — each stage with its own organizer-facing prompt.
 *
 * This module is pure data + pure functions (no I/O, no SDK) so it is shared by the
 * server (organizer/research wiring) and the web ("+" form dropdown) and is unit
 * tested in isolation. UI labels are English (web text rule); stage prompts are
 * Chinese to match the codebase's agent-facing prompt convention.
 */

/**
 * The four canonical stages every discussion workflow moves through, in order.
 * - `discuss`   — keep the floor open, let the parties diverge/explore.
 * - `summarize` — converge: the organizer summarizes what was said.
 * - `confirm`   — check the summary back with each party.
 * - `conclude`  — record the final conclusion (terminal).
 */
export type DiscussionStageKind = 'discuss' | 'summarize' | 'confirm' | 'conclude'

/** Canonical stage order; every type's workflow follows it (prompts differ by type). */
export const DISCUSSION_STAGE_ORDER: readonly DiscussionStageKind[] = [
  'discuss',
  'summarize',
  'confirm',
  'conclude',
] as const

/** One workflow stage: an organizer instruction for a point in the discussion. */
export interface DiscussionWorkflowStage {
  /** Which canonical stage this is (unique within a workflow). */
  id: DiscussionStageKind
  /** Short English label for display. */
  label: string
  /** Organizer-facing prompt: what to do at this stage. */
  prompt: string
}

/** One discussion type and the workflow its organizer follows. */
export interface DiscussionTypeDef {
  /** Stable machine id, e.g. `brainstorm`. Also the `Discussion.type` value. */
  id: string
  /** English UI label. */
  label: string
  /** One-line English description for the form. */
  description: string
  /** Ordered workflow stages (always one per `DISCUSSION_STAGE_ORDER` entry). */
  workflow: DiscussionWorkflowStage[]
}

const STAGE_LABEL: Record<DiscussionStageKind, string> = {
  discuss: 'Discuss',
  summarize: 'Summarize',
  confirm: 'Confirm',
  conclude: 'Conclude',
}

/** Build a 4-stage workflow from per-stage prompts (keeps the catalog terse). */
function workflow(prompts: Record<DiscussionStageKind, string>): DiscussionWorkflowStage[] {
  return DISCUSSION_STAGE_ORDER.map((id) => ({ id, label: STAGE_LABEL[id], prompt: prompts[id] }))
}

/**
 * The discussion type catalog. Add a type by appending an entry — server and web
 * both read from here, so a new type needs no other wiring.
 */
export const DISCUSSION_TYPES: readonly DiscussionTypeDef[] = [
  {
    id: 'brainstorm',
    label: 'Brainstorm',
    description: 'Diverge widely to generate ideas, then converge on the promising ones.',
    workflow: workflow({
      discuss: '广开思路:鼓励各方尽量多地抛出点子,先不评判、不收敛,保持发散。',
      summarize: '归类汇总所有点子,合并重复项,标出最有潜力的几条方向。',
      confirm: '把候选方向逐一向各方确认:是否理解一致、有无遗漏或反对。',
      conclude: '形成头脑风暴结论:选定的方向与后续可探索项,记入 conclusion。',
    }),
  },
  {
    id: 'decision',
    label: 'Decision',
    description: 'Compare options against criteria and pick one.',
    workflow: workflow({
      discuss: '让各方提出候选方案与评估标准,充分陈述各方案的利弊与取舍。',
      summarize: '按统一标准对比各方案,给出倾向性建议及其理由。',
      confirm: '向各方确认所选方案:风险是否可接受、是否有阻断性异议。',
      conclude: '下最终决策结论:选定方案、关键理由与待办,记入 conclusion。',
    }),
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Review a proposal or design and surface issues to address.',
    workflow: workflow({
      discuss: '请评审各方对照目标逐点审阅,提出问题、风险与改进建议。',
      summarize: '汇总评审意见,按严重度归类,区分必须修改与可选优化。',
      confirm: '向提案方与评审方确认问题清单与处置意见是否达成一致。',
      conclude: '形成评审结论:通过/有条件通过/不通过及整改项,记入 conclusion。',
    }),
  },
  {
    id: 'planning',
    label: 'Planning',
    description: 'Break a goal into a sequenced plan with owners and milestones.',
    workflow: workflow({
      discuss: '围绕目标讨论范围、拆解任务、识别依赖与里程碑,广泛收集输入。',
      summarize: '整理出有先后顺序的计划草案:任务、负责人、依赖与时间点。',
      confirm: '向各责任方确认计划可行性与承诺,核对依赖与排期。',
      conclude: '锁定最终规划:排定的任务序列与里程碑,记入 conclusion。',
    }),
  },
  {
    id: 'retro',
    label: 'Retro',
    description: 'Reflect on what happened, why, and what to change next.',
    workflow: workflow({
      discuss: '收集事实:让各方回顾发生了什么、哪些顺利哪些不顺,并分析归因。',
      summarize: '归纳出可执行的改进行动项,并标注负责人与优先级。',
      confirm: '向各方确认行动项是否合理、是否认领,核对没有遗漏。',
      conclude: '形成复盘结论:关键教训与确定的行动项,记入 conclusion。',
    }),
  },
] as const

/** All discussion types in catalog order. */
export function listDiscussionTypes(): readonly DiscussionTypeDef[] {
  return DISCUSSION_TYPES
}

/** Look up a type definition by id, or `undefined` if unknown. */
export function getDiscussionType(id: string): DiscussionTypeDef | undefined {
  return DISCUSSION_TYPES.find((t) => t.id === id)
}

/** Whether `id` names a known discussion type. */
export function isDiscussionType(id: string): boolean {
  return getDiscussionType(id) !== undefined
}

/** A type's ordered workflow stages, or `[]` for an unknown type. */
export function discussionWorkflow(id: string): DiscussionWorkflowStage[] {
  return getDiscussionType(id)?.workflow ?? []
}

/**
 * The stage following `currentStageId` in a type's workflow, or `undefined` when
 * `currentStageId` is the last stage or unknown. With no `currentStageId`, returns
 * the first stage (the entry point).
 */
export function nextDiscussionStage(
  id: string,
  currentStageId?: DiscussionStageKind,
): DiscussionWorkflowStage | undefined {
  const stages = discussionWorkflow(id)
  if (stages.length === 0) return undefined
  if (!currentStageId) return stages[0]
  const idx = stages.findIndex((s) => s.id === currentStageId)
  if (idx === -1) return undefined
  return stages[idx + 1]
}
