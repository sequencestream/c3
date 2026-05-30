/*
 * useSpeechRecognition — 浏览器 Web Speech API（SpeechRecognition）的轻封装。
 *
 * 只做语音转文字。特性检测后给出 supported；不支持的浏览器（如 Firefox）下
 * 调用方据此隐藏麦克风按钮。状态机：idle → listening → idle，出错转 error。
 *
 * Chrome 静默数秒会自动触发 onend；只要用户没主动 stop，就在 onend 里重启，
 * 维持「持续聆听」直到再次 toggle。识别文本通过 onResult(final, interim) 回调
 * 上抛：final 为本轮已确定的累积文本，interim 为当前未定的中间结果。
 */
import { ref, shallowRef, onUnmounted } from 'vue'

// Web Speech API 尚未进入 TS 标准库，按需声明用到的最小子集。
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  item(i: number): { transcript: string }
  [i: number]: { transcript: string }
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number
  readonly results: {
    readonly length: number
    item(i: number): SpeechRecognitionResultLike
    [i: number]: SpeechRecognitionResultLike
  }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: Event & { error?: string }) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export type RecognitionState = 'idle' | 'listening' | 'error'

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useSpeechRecognition(onResult: (final: string, interim: string) => void) {
  const Ctor = getCtor()
  const supported = !!Ctor
  const state = ref<RecognitionState>('idle')
  const errorMessage = ref('')

  const rec = shallowRef<SpeechRecognitionLike | null>(null)
  // 区分「用户主动停止」与「Chrome 自动 onend」：后者需重启以保持聆听。
  let stopping = false
  // 本轮（一次 toggle）已确定的累积文本，跨自动重启保留。
  let finalText = ''

  function build(lang: string): SpeechRecognitionLike {
    const r = new (Ctor as SpeechRecognitionCtor)()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        const text = res[0]?.transcript ?? ''
        if (res.isFinal) finalText += text
        else interim += text
      }
      onResult(finalText, interim)
    }
    r.onerror = (e) => {
      // no-speech / aborted 属正常中断，不当作错误展示。
      const err = e.error ?? ''
      if (err === 'no-speech' || err === 'aborted') return
      errorMessage.value =
        err === 'not-allowed' || err === 'service-not-allowed'
          ? '麦克风权限被拒绝，请在浏览器设置中允许'
          : `语音识别出错：${err || '未知错误'}`
      state.value = 'error'
      stopping = true
    }
    r.onend = () => {
      // 用户没主动停 ⇒ Chrome 自动断开，重启以维持聆听。
      if (!stopping && state.value === 'listening') {
        try {
          r.start()
          return
        } catch {
          /* 重启失败则落到 idle */
        }
      }
      if (state.value !== 'error') state.value = 'idle'
    }
    return r
  }

  function start(lang: string) {
    if (!supported || state.value === 'listening') return
    finalText = ''
    stopping = false
    errorMessage.value = ''
    try {
      const r = build(lang)
      rec.value = r
      state.value = 'listening'
      r.start()
    } catch {
      state.value = 'error'
      errorMessage.value = '无法启动语音识别'
    }
  }

  function stop() {
    stopping = true
    rec.value?.stop()
    if (state.value === 'listening') state.value = 'idle'
  }

  onUnmounted(() => {
    stopping = true
    rec.value?.abort()
  })

  return { supported, state, errorMessage, start, stop }
}
