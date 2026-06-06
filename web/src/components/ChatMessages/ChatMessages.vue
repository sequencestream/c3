<script setup lang="ts">
/*
 * ChatMessages.vue — 会话消息渲染区（含自动滚动到底）
 *
 * 把扁平的消息列表分组成渲染块：文本消息直通；夹在文本之间的连续工具消息合成一个
 * 可折叠的 batch。工具调用/结果在此内联渲染，权限提示与共识结果委托给子组件。
 */
import { ref, computed, nextTick, watch } from 'vue'
import PermissionPrompt from '../PermissionPrompt/PermissionPrompt.vue'
import ConsensusBlock from '../ConsensusBlock/ConsensusBlock.vue'
import MarkdownText from '../MarkdownText/MarkdownText.vue'
import { fmt, oneLine } from '../../lib/format'
import type { Block, ChatMsg, PermissionMsg, TextMsg } from '../../lib/chat-types'
import type { VendorId } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

// Fixed protocol identifiers shown verbatim (do-not-translate; bound via consts
// so `no-raw-text` doesn't flag them as hard-coded copy).
const TOOL_USE_LABEL = 'tool_use'
const TOOL_RESULT_LABEL = 'tool_result'

// Vendor brand labels shown verbatim on a discussion speaker's vendor tag
// (do-not-translate brand names per i18n-terms; bound via a const map so
// `no-raw-text` doesn't flag them). A heterogeneous roundtable thus shows which
// vendor each agent runs on while every bubble normalizes to the same layout.
const VENDOR_LABEL: Record<VendorId, string> = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
}

const props = defineProps<{
  messages: ChatMsg[]
  hasActiveSession: boolean
  // The single permission the user can still act on (live, still-pending), or
  // null. Permissions other than this one render as static history records.
  actionablePermissionId: string | null
}>()

const emit = defineEmits<{
  respond: [m: PermissionMsg, decision: 'allow' | 'deny']
  'submit-ask': [m: PermissionMsg, answers: Record<string, string>]
}>()

const mainEl = ref<HTMLElement | null>(null)
const expanded = ref<Set<number>>(new Set())
const expandedBatches = ref<Set<number>>(new Set())

// Keep the view pinned to the latest message as the buffer grows or a session loads.
watch(
  () => props.messages.length,
  () => {
    nextTick(() => {
      if (mainEl.value) mainEl.value.scrollTop = mainEl.value.scrollHeight
    })
  },
)

const TOOL_KINDS = new Set(['tool-use', 'tool-result', 'permission', 'consensus'])

/**
 * Reorder a batch so each tool-result sits directly under its matching tool-use
 * (paired by `toolUseId`) and is flagged for indentation. Parallel tool calls
 * arrive interleaved (use_A, use_B, result_A, result_B); this pulls each result
 * back next to its use. A result whose use isn't in this batch (orphan) stays in
 * place, un-indented; a use whose result hasn't streamed in yet renders alone.
 */
function orderRows(msgs: ChatMsg[]): { msg: ChatMsg; indent: boolean }[] {
  const useIds = new Set(
    msgs.flatMap((m) => (m.kind === 'tool-use' && m.toolUseId ? [m.toolUseId] : [])),
  )
  const resultByUse = new Map<string, ChatMsg>()
  for (const m of msgs) if (m.kind === 'tool-result' && m.toolUseId) resultByUse.set(m.toolUseId, m)

  const rows: { msg: ChatMsg; indent: boolean }[] = []
  for (const m of msgs) {
    // A result handled under its use is emitted there, not at its own position.
    if (m.kind === 'tool-result' && m.toolUseId && useIds.has(m.toolUseId)) continue
    rows.push({ msg: m, indent: false })
    if (m.kind === 'tool-use' && m.toolUseId) {
      const result = resultByUse.get(m.toolUseId)
      if (result) rows.push({ msg: result, indent: true })
    }
  }
  return rows
}

/**
 * Group the flat message list into render blocks: text messages pass through;
 * runs of tool messages between text become one collapsible batch.
 */
const blocks = computed<Block[]>(() => {
  const out: Block[] = []
  let batch: ChatMsg[] = []
  const flush = () => {
    if (batch.length === 0) return
    const msgs = batch
    batch = []
    // `Name.count` per distinct tool, in first-seen order. Count tool-use calls;
    // fall back to permission tool names when a batch has no executed tool-use.
    const counts = new Map<string, number>()
    for (const m of msgs)
      if (m.kind === 'tool-use') counts.set(m.toolName, (counts.get(m.toolName) ?? 0) + 1)
    if (counts.size === 0)
      for (const m of msgs)
        if (m.kind === 'permission') counts.set(m.toolName, (counts.get(m.toolName) ?? 0) + 1)
    const summary = [...counts].map(([name, n]) => `${name}.${n}`).join('  ')
    // Collapsed-header hint: a single-line preview of the first tool-use's input,
    // so the batch shows *what* it's doing, not just the per-tool counts. '' when
    // the batch carries no executed tool-use (e.g. permission-only) — then the
    // header degrades to the bare summary (no preview appended).
    let preview = ''
    for (const m of msgs)
      if (m.kind === 'tool-use') {
        preview = oneLine(fmt(m.input))
        break
      }
    // Only a genuinely actionable (live, pending) permission forces the batch
    // open. Historical permissions replayed from the buffer stay collapsed.
    const hasPending = msgs.some(
      (m) => m.kind === 'permission' && m.requestId === props.actionablePermissionId,
    )
    out.push({
      type: 'batch',
      key: `b${msgs[0].id}`,
      id: msgs[0].id,
      msgs,
      rows: orderRows(msgs),
      summary,
      preview,
      hasPending,
    })
  }
  for (const m of props.messages) {
    if (TOOL_KINDS.has(m.kind)) {
      batch.push(m)
    } else {
      flush()
      out.push({ type: 'text', key: `t${m.id}`, msg: m as TextMsg })
    }
  }
  flush()
  return out
})

function isBatchOpen(b: Extract<Block, { type: 'batch' }>): boolean {
  // A pending permission forces the batch open so the prompt can't be missed.
  return expandedBatches.value.has(b.id) || b.hasPending
}

function toggleBatch(id: number): void {
  const next = new Set(expandedBatches.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedBatches.value = next
}

function isExpanded(id: number): boolean {
  return expanded.value.has(id)
}

function toggle(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
</script>

<template>
  <main ref="mainEl">
    <p v-if="!hasActiveSession" class="empty-main">
      {{ t('session.chat.empty') }}
    </p>
    <template v-for="b in blocks" :key="b.key">
      <div v-if="b.type === 'text'" class="msg" :class="b.msg.kind">
        <!--
          Multi-speaker header (set by the discussion path via ChatBody.speaker):
          a small line with the speaker's icon + name above the body. The
          session path never sets `speaker`, so the bubble renders header-less —
          the existing single-speaker layout is preserved bit-for-bit.
          The `v-if` re-narrows `b.msg` to user|assistant (the only variants
          that carry `speaker`); `system` keeps the original header-less layout.
        -->
        <template v-if="b.msg.kind === 'user' || b.msg.kind === 'assistant'">
          <div v-if="b.msg.speaker" class="speaker">
            <span class="speaker-icon">{{ b.msg.speaker.icon }}</span>
            <span class="speaker-name">{{ b.msg.speaker.name }}</span>
            <!--
              Vendor tag — only on a discussion `agent` turn whose vendor resolved
              (human/organizer carry none). Makes a heterogeneous roundtable (e.g. a
              Claude agent next to an OpenCode agent) visually attributable.
            -->
            <span
              v-if="b.msg.speaker.vendor"
              class="vendor-tag"
              :class="`vendor-${b.msg.speaker.vendor}`"
              >{{ VENDOR_LABEL[b.msg.speaker.vendor] }}</span
            >
          </div>
        </template>
        <MarkdownText :text="b.msg.text" :kind="b.msg.kind" />
      </div>
      <div v-else class="batch" :class="{ open: isBatchOpen(b) }">
        <div class="batch-head" @click="toggleBatch(b.id)">
          <span class="caret">{{ isBatchOpen(b) ? '▾' : '▸' }}</span>
          <!--
            Collapsed header: `Name.count` summary, then a one-line preview of the
            first tool-use's input. The preview shows only while collapsed (open
            bodies already render each input in full); the leading space is baked
            into the interpolation so Vue's whitespace condense can't drop it. The
            whole line shares `.batch-summary`'s nowrap + ellipsis, so overflow
            truncates with `…` without breaking the header layout.
          -->
          <span class="batch-summary"
            >{{ b.summary || t('session.chat.toolsFallback')
            }}<span v-if="b.preview && !isBatchOpen(b)" class="batch-preview">{{
              ' ' + b.preview
            }}</span></span
          >
        </div>
        <div v-if="isBatchOpen(b)" class="batch-body">
          <div
            v-for="{ msg: m, indent } in b.rows"
            :key="m.id"
            class="msg"
            :class="[m.kind, { error: m.kind === 'tool-result' && m.isError, indented: indent }]"
          >
            <template v-if="m.kind === 'tool-use'">
              <div class="label tool-label" @click="toggle(m.id)">
                <span class="caret">{{ isExpanded(m.id) ? '▾' : '▸' }}</span>
                {{ TOOL_USE_LABEL }} · {{ m.toolName }}
                <!--
                  Pre-approved audit tag: the vendor's own rule engine auto-allowed
                  this tool, so it never raised a c3 permission prompt. The amber
                  「vendor pre-approved」 tag contrasts with PermissionPrompt's green
                  「c3 allowed」 decided state — together they make explicit that c3
                  is a gateway, not the sole permission authority (PG-R12).
                -->
                <span v-if="m.preApproved" class="approval-tag pre-approved">{{
                  t('session.chat.preApproved')
                }}</span>
              </div>
              <pre v-if="isExpanded(m.id)" class="tool-body">{{ fmt(m.input) }}</pre>
              <div v-else class="tool-oneline" @click="toggle(m.id)">
                {{ oneLine(fmt(m.input)) }}
              </div>
            </template>
            <template v-else-if="m.kind === 'tool-result'">
              <template v-if="isExpanded(m.id)">
                <div class="label tool-label" @click="toggle(m.id)">
                  <span class="caret">▾</span>
                  {{ TOOL_RESULT_LABEL
                  }}<template v-if="m.isError"> {{ t('session.chat.resultError') }}</template>
                </div>
                <pre class="tool-body">{{ m.content }}</pre>
              </template>
              <div v-else class="tool-oneline" @click="toggle(m.id)">
                {{ oneLine(m.content) }}
              </div>
            </template>
            <PermissionPrompt
              v-else-if="m.kind === 'permission'"
              :m="m"
              :actionable="m.requestId === actionablePermissionId"
              @respond="(pm, decision) => emit('respond', pm, decision)"
              @submit-ask="(pm, answers) => emit('submit-ask', pm, answers)"
            />
            <ConsensusBlock v-else-if="m.kind === 'consensus'" :m="m" />
          </div>
        </div>
      </div>
    </template>
  </main>
</template>

<style scoped>
/* Multi-speaker header on a text bubble. Small muted line above the body,
   visually echoing chat-app speaker rows. Only rendered when ChatBody.speaker
   is set (the discussion path); session bubbles never get this row. */
.speaker {
  display: flex;
  align-items: baseline;
  gap: 0.4em;
  margin: 0 0 0.25em;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  line-height: 1.2;
}
.speaker-icon {
  /* Icons are user-supplied emoji / short text — keep them baseline-aligned
     with the name so multi-codepoint glyphs (ZWJ, flags) sit nicely. */
  font-size: 1.1em;
  line-height: 1;
}
.speaker-name {
  font-weight: 600;
}

/* Vendor tag — a small pill on the speaker line, one hue per vendor so a
   heterogeneous roundtable is attributable at a glance. Soft bg + colored text,
   reusing theme tokens (no new hard-coded hues). */
.vendor-tag {
  font-size: var(--fs-caption);
  font-weight: 600;
  line-height: 1.3;
  padding: 0 0.45em;
  border-radius: 999px;
  letter-spacing: 0.01em;
}
.vendor-claude {
  color: var(--c-primary);
  background: var(--c-primary-soft);
}
.vendor-opencode {
  color: var(--c-purple-text);
  background: var(--c-purple-soft);
}
.vendor-codex {
  color: var(--c-info, #3b82f6);
  background: rgba(59, 130, 246, 0.15);
}

/* Approval provenance tags — the two-color legend that makes "c3 is a gateway,
   not the sole authority" explicit. `pre-approved` (amber): the vendor's own
   rule engine allowed the tool, c3 was a bystander. The complementary green
   "c3 allowed" state lives on PermissionPrompt's decided row. */
.approval-tag {
  margin-left: 0.5em;
  font-size: var(--fs-caption);
  font-weight: 600;
  line-height: 1.3;
  padding: 0 0.45em;
  border-radius: 999px;
}
.approval-tag.pre-approved {
  color: var(--c-warning);
  background: rgba(245, 158, 11, 0.15);
}
</style>
