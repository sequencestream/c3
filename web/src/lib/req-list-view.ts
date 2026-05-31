/*
 * req-list-view.ts — 需求列表面板的纯展示逻辑。
 *
 * 面板有展开/收缩两态:收缩态收窄面板宽度并隐藏次要字段(模块名、操作按钮),
 * 展开态恢复完整宽度并显示全部字段。此处只承载与折叠态相关的纯函数,
 * 便于在 Node 环境下单测(项目的 web 测试不含 DOM)。
 */

/** 标题栏切换按钮的文案与 title,反映「点击后将切换到的」目标态。 */
export interface ToggleLabel {
  icon: string
  text: string
  title: string
}

export function panelToggleLabel(collapsed: boolean): ToggleLabel {
  return collapsed
    ? { icon: '⇥', text: '展开', title: '展开需求列表(显示模块名与操作按钮)' }
    : { icon: '⇤', text: '收起', title: '收起需求列表(隐藏模块名与操作按钮,腾出聊天空间)' }
}

/** 行内次要字段在当前折叠态下是否渲染。收缩态隐藏模块名与操作区。 */
export interface RowVisibility {
  showModule: boolean
  showActions: boolean
}

export function rowVisibility(collapsed: boolean): RowVisibility {
  return { showModule: !collapsed, showActions: !collapsed }
}
