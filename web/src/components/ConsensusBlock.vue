<script setup lang="ts">
/*
 * ConsensusBlock.vue — 多 agent 共识的自动裁定结果（只读展示）
 *
 * 两种形态：AskUserQuestion 的逐题自动作答，以及其它工具的 allow/deny 裁定。
 */
import type { ChatMsg } from '../lib/chat-types'

defineProps<{ m: Extract<ChatMsg, { kind: 'consensus' }> }>()
</script>

<template>
  <!-- AskUserQuestion: per-question auto-answer -->
  <template v-if="m.outcome.kind === 'ask'">
    <div class="label">
      🤝 Multi-agent consensus · <code>{{ m.toolName }}</code>
      <span class="consensus-badge allow">Auto-answered per question</span>
    </div>
    <div class="consensus">
      <div class="consensus-summary">{{ m.outcome.summary }}</div>
      <ul class="consensus-questions">
        <li v-for="q in m.outcome.perQuestion" :key="q.index">
          <div class="cq-head">
            <span v-if="q.header" class="ask-q-header">{{ q.header }}</span>
            <span class="cq-agreed" :class="{ split: !q.unanimous }">{{
              q.unanimous ? q.agreed : '(disagreement → manual)'
            }}</span>
          </div>
          <div class="cq-votes">
            <span v-for="a in q.answers" :key="a.agentId" class="cq-vote">
              <span class="vote-name">{{ a.agentName }}</span>
              <span class="vote-reason">{{
                a.abstain ? 'Abstained' : a.optionLabels.join('/') || a.custom
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
      🤝 Multi-agent consensus ·
      <code>{{ m.toolName }}</code>
      <span class="consensus-badge" :class="m.outcome.decision ?? 'split'">{{
        m.outcome.decision === 'allow'
          ? 'Auto-allowed'
          : m.outcome.decision === 'deny'
            ? 'Auto-denied'
            : 'Disagreement'
      }}</span>
    </div>
    <div class="consensus">
      <div class="consensus-summary">{{ m.outcome.summary }}</div>
      <ul class="consensus-votes">
        <li v-for="v in m.outcome.votes" :key="v.agentId">
          <span class="vote-name">{{ v.agentName }}</span>
          <span class="vote-decision" :class="v.decision">{{ v.decision }}</span>
          <span class="vote-reason">{{ v.reason }}</span>
        </li>
      </ul>
    </div>
  </template>
</template>
