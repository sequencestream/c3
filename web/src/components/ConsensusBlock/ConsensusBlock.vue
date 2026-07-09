<script setup lang="ts">
/*
 * ConsensusBlock.vue — 多 agent 共识的自动裁定结果（只读展示）
 *
 * 两种形态：AskUserQuestion 的逐题自动作答，以及其它工具的 allow/deny 裁定。
 * 工具裁定展示 vendor 中立的归一化风险载荷（参与投票的 agent 可跨 vendor）；
 * 归一化失败时展示转人工提示。不再展示「限某 vendor 内」的旧提示。
 */
import type { ChatMsg } from '../../lib/chat-types'
import type { NormalizedToolRisk } from '@ccc/shared/protocol'
import { VENDOR_LABEL } from '../../lib/vendor'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

defineProps<{ m: Extract<ChatMsg, { kind: 'consensus' }> }>()

/** The active risk axes (read/write/execute/network) of a normalized payload, in order. */
const AXES = ['read', 'write', 'execute', 'network'] as const
type Axis = (typeof AXES)[number]
function activeAxes(risks: NormalizedToolRisk['risks']): Axis[] {
  return AXES.filter((a) => risks[a])
}
/** Localized axis label via explicit literal keys (typed `t` rejects template keys). */
function axisLabel(axis: Axis): string {
  switch (axis) {
    case 'read':
      return t('discussion.consensus.risk.read')
    case 'write':
      return t('discussion.consensus.risk.write')
    case 'execute':
      return t('discussion.consensus.risk.execute')
    case 'network':
      return t('discussion.consensus.risk.network')
  }
}
</script>

<template>
  <!-- AskUserQuestion: per-question auto-answer -->
  <template v-if="m.outcome.kind === 'ask'">
    <div class="label">
      {{ t('discussion.consensus.title.label') }} <code>{{ m.toolName }}</code>
      <span class="consensus-badge allow">{{ t('discussion.consensus.autoAnswered.label') }}</span>
    </div>
    <div class="consensus">
      <div class="consensus-summary">{{ m.outcome.summary }}</div>
      <ul class="consensus-questions">
        <li v-for="q in m.outcome.perQuestion" :key="q.index">
          <div class="cq-head">
            <span v-if="q.header" class="ask-q-header">{{ q.header }}</span>
            <span class="cq-agreed" :class="{ split: !q.unanimous }">{{
              q.unanimous ? q.agreed : t('discussion.consensus.disagreementManual.label')
            }}</span>
          </div>
          <div class="cq-votes">
            <span v-for="a in q.answers" :key="a.agentId" class="cq-vote">
              <span class="vote-name">{{ a.agentName }}</span>
              <span v-if="a.vendor" class="vote-vendor">{{ VENDOR_LABEL[a.vendor] }}</span>
              <span class="vote-reason">{{
                a.abstain
                  ? t('discussion.consensus.abstained.label')
                  : a.optionLabels.join('/') || a.custom
              }}</span>
            </span>
          </div>
        </li>
      </ul>
    </div>
  </template>

  <!-- Every other tool: allow / deny verdict -->
  <template v-else>
    <div class="label">
      {{ t('discussion.consensus.title.label') }}
      <code>{{ m.toolName }}</code>
      <span class="consensus-badge" :class="m.outcome.decision ?? 'split'">{{
        m.outcome.decision === 'allow'
          ? t('discussion.consensus.autoAllowed.label')
          : m.outcome.decision === 'deny'
            ? t('discussion.consensus.autoDenied.label')
            : t('discussion.consensus.disagreement.label')
      }}</span>
    </div>
    <div class="consensus">
      <div class="consensus-summary">{{ m.outcome.summary }}</div>
      <!-- Vendor-neutral normalized risk payload the cross-vendor voters judged. -->
      <div v-if="m.outcome.normalized" class="consensus-risk">
        <span class="risk-intent">{{ m.outcome.normalized.operationIntent }}</span>
        <span class="risk-axes">
          <span
            v-for="axis in activeAxes(m.outcome.normalized.risks)"
            :key="axis"
            class="risk-axis"
            :class="axis"
            >{{ axisLabel(axis) }}</span
          >
        </span>
        <span v-if="m.outcome.normalized.resourceScope.targets.length" class="risk-targets">{{
          m.outcome.normalized.resourceScope.targets.join(', ')
        }}</span>
      </div>
      <!-- Normalization failed ⇒ every voter abstained, request deferred to human. -->
      <div v-else-if="m.outcome.normalizationFailure" class="consensus-norm-failed">
        {{
          t('discussion.consensus.normalizationFailed.label', {
            reason: m.outcome.normalizationFailure,
          })
        }}
      </div>
      <ul class="consensus-votes">
        <li v-for="v in m.outcome.votes" :key="v.agentId">
          <span class="vote-name">{{ v.agentName }}</span>
          <span v-if="v.vendor" class="vote-vendor">{{ VENDOR_LABEL[v.vendor] }}</span>
          <span class="vote-decision" :class="v.decision">{{ v.decision }}</span>
          <span class="vote-reason">{{ v.reason }}</span>
        </li>
      </ul>
    </div>
  </template>
</template>
