import { ref, watch, type Ref } from 'vue'

/**
 * 一个绑定 localStorage 的布尔 ref:用于记住列表面板的收缩/展开态,
 * 跨页面切换(乃至刷新)后仍保持原状。读写都包 try/catch,localStorage
 * 不可用(隐私模式/配额)时退化为纯内存 ref,不影响交互。
 *
 * 键名沿用 App.vue 的 `c3.` 前缀约定。
 */
export function usePersistentToggle(key: string, defaultValue = false): Ref<boolean> {
  const initial = ((): boolean => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? defaultValue : raw === 'true'
    } catch {
      return defaultValue
    }
  })()

  const state = ref(initial)

  watch(state, (v) => {
    try {
      localStorage.setItem(key, String(v))
    } catch {
      // localStorage unavailable — keep in-memory state only.
    }
  })

  return state
}
