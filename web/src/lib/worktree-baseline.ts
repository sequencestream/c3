/*
 * worktree 基线提示 —— 「这个目录不在基准分支的最新提交上」这条事实的前端类型。
 *
 * 它和 gate-escape 是两回事:那里是启动被拦下之后才谈出口,这里的会话已经跑起来
 * 了。基线落后不影响继续开发,真正要处理的时点是 PR 合并,所以提示常驻在意图详情
 * 里、不弹窗、不禁用任何操作,只把两个修复动作摆在用户手边 —— 重建与合入依旧只由
 * 人触发,c3 从不自动做其中任何一件。
 */
import type { ServerToClient } from '@ccc/shared/protocol'

/** 服务端推来的那一帧,原样留存。 */
export type WorktreeBaselineNotice = Extract<
  ServerToClient,
  { type: 'intent_worktree_baseline_notice' }
>
