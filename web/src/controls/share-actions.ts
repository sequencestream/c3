/**
 * App controller — 分享动作。统一封装「取 baseUrl → 拼深链 → 写剪贴板 → toast」:
 * 三处标题栏(会话 / 意图 / 讨论)只发 `share` 事件,由 App 组装 `ShareTarget` 调本方法。
 * baseUrl 未配置时不写剪贴板,改弹「去系统设置填写」提示(非静默)。
 */
import { buildShareText, type ShareTarget } from '@/lib/share-link'
import type { AppCtx } from './types'

export function installShareActions(ctx: AppCtx): void {
  ctx.shareLink = (target: ShareTarget): void => {
    const text = buildShareText({ ...target, baseUrl: ctx.serverSettings.value?.baseUrl })
    if (text === null) {
      // baseUrl 未配置:引导去系统设置,且不写剪贴板。
      ctx.showToast(ctx.t('share.baseUrlMissing.toast'))
      return
    }
    // 沿用 IntentDetail 复制 PR id 的乐观写法;无 clipboard API 时静默降级、不报错。
    void navigator.clipboard?.writeText(text)
    ctx.showToast(ctx.t('share.copied.toast'))
  }
}
