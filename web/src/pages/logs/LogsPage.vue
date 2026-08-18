<script setup lang="ts">
/*
 * LogsPage.vue — 运行日志查看器,挂在独立 hash 路由 `#/logs` 上的根组件。
 *
 * 它是一个自成一体的页面:自己建 WebSocket(带本浏览器的会话令牌)、自己按节拍轮询
 * `read_runtime_log`、自己维护展示缓冲区。主应用在另一个标签页里照常运行,两者除了共享
 * localStorage 里的令牌之外没有任何耦合。
 *
 * 轮询按「页面可见」门控:标签页切走即停,切回立刻补一次再恢复节拍。刻意不叠加焦点门控
 * —— 日志常被摆在旁边的窗口里盯着看,失焦不等于不看。
 *
 * 缓冲区上限见 log-view.ts:超限丢最早的行,长时间开着不会把标签页内存吃穿。
 *
 * 视图默认跟随最新一行;用户往上滚去读旧内容时停止跟随,滚回底部又恢复 —— 判定复用
 * 聊天列的 isNearBottom。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createWsClient, type WsStatus } from '@/lib/ws'
import { getToken } from '@/lib/authToken'
import { isNearBottom } from '@/lib/chat-scroll'
import { createGatedPoller } from '@/lib/poller'
import {
  LOG_POLL_INTERVAL_MS,
  applyLogChunk,
  createLogViewState,
  logViewText,
} from '@/lib/log-view'
import { useTypedI18n, type LocaleKey } from '@/i18n'

const props = defineProps<{
  /** 传输层接缝:默认真连 WebSocket,测试注入假工厂。 */
  createClient?: typeof createWsClient
}>()

const { t } = useTypedI18n()

const status = ref<WsStatus>('connecting')
const view = ref(createLogViewState())
const unauthenticated = ref(false)
const following = ref(true)
const body = ref<HTMLElement | null>(null)

const CONNECTION_KEY: Record<WsStatus, LocaleKey> = {
  connecting: 'logs.connection.connecting',
  open: 'logs.connection.open',
  closed: 'logs.connection.closed',
}

const text = computed(() => logViewText(view.value))
const isEmpty = computed(() => text.value.length === 0)

let client: ReturnType<typeof createWsClient> | null = null

/** 页面可见即轮询(不叠加焦点门控)。 */
function isActive(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function requestChunk(): void {
  if (status.value !== 'open') return
  // 首次(nextOffset 为 0 且缓冲区为空)不带 offset:服务端给尾部一段历史,页面不至于空白。
  const isFirst = view.value.nextOffset === 0 && view.value.lines.length === 0
  client?.send({
    type: 'read_runtime_log',
    ...(isFirst ? {} : { offset: view.value.nextOffset }),
  })
}

const poller = createGatedPoller({
  intervalMs: LOG_POLL_INTERVAL_MS,
  isActive,
  request: requestChunk,
})

onMounted(() => {
  client = (props.createClient ?? createWsClient)({
    onMessage: (msg) => {
      if (msg.type === 'runtime_log') {
        view.value = applyLogChunk(view.value, msg.chunk)
        unauthenticated.value = false
      } else if (msg.type === 'unauthenticated') {
        unauthenticated.value = true
      }
    },
    onStatus: (s) => {
      status.value = s
      // 连接刚打开(含重连)才有得可拉;断开时停表,重连后从当前 offset 续读。
      if (s === 'open') poller.sync()
      else poller.stop()
    },
    getToken,
  })
  document.addEventListener('visibilitychange', poller.sync)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', poller.sync)
  poller.stop()
  client?.close()
  client = null
})

function onScroll(): void {
  const el = body.value
  if (!el) return
  following.value = isNearBottom({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  })
}

watch(text, async () => {
  if (!following.value) return
  await nextTick()
  const el = body.value
  if (el) el.scrollTop = el.scrollHeight
})
</script>

<template>
  <div class="logs-page">
    <header class="logs-header">
      <h1 class="logs-title">{{ t('logs.title') }}</h1>
      <span class="status" :class="status === 'open' ? 'ok' : 'err'" data-testid="logs-status">
        {{ t(CONNECTION_KEY[status]) }}
      </span>
      <span v-if="view.dropped" class="logs-note" data-testid="logs-truncated">
        {{ t('logs.truncated') }}
      </span>
    </header>

    <p v-if="unauthenticated" class="logs-empty" data-testid="logs-unauthenticated">
      {{ t('logs.unauthenticated') }}
    </p>
    <p v-else-if="!view.available" class="logs-empty" data-testid="logs-unavailable">
      {{ t('logs.unavailable') }}
    </p>
    <p v-else-if="isEmpty" class="logs-empty" data-testid="logs-empty">{{ t('logs.empty') }}</p>

    <pre ref="body" class="logs-body" data-testid="logs-body" @scroll="onScroll">{{ text }}</pre>
  </div>
</template>

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--c-bg);
  color: var(--c-text);
}

.logs-header {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  background: var(--c-panel);
  border-bottom: 1px solid var(--c-border);
}

.logs-title {
  margin: 0;
  font-size: var(--fs-title-sm);
  font-weight: 600;
}

.logs-note {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}

.logs-empty {
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-body);
  color: var(--c-text-muted);
}

.logs-body {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--c-code);
  font-family: var(--font-mono);
  font-size: var(--fs-code);
  line-height: var(--lh-normal);
}
</style>
