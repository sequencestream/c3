/*
 * datetime-formats.ts — 日期 / 数字「命名预设」的单一数据源(Intl 选项)。
 *
 * 同时供两处消费,避免格式漂移:
 *   - vue-i18n 的 `datetimeFormats` / `numberFormats`(组件内 `d()` / `n()`,见 i18n/index.ts);
 *   - 纯展示 lib(`intent-list-view.ts` 的 `formatDate`,Node 单测环境直接 `new Intl.DateTimeFormat`)。
 *
 * 输出顺序由 locale 决定(en → MM/DD、ja/zh/ko → 年在前),正是本地化目标。
 */

export type DateStyleName = 'short' | 'date' | 'full' | 'datetime'

/** 命名日期预设。各 locale 复用同一份选项,由 Intl 按 locale 本地化排布。 */
export const DATE_FORMATS: Record<DateStyleName, Intl.DateTimeFormatOptions> = {
  // 月/日两位 —— 列表行内日期前缀(原 MM/DD)。
  short: { month: '2-digit', day: '2-digit' },
  // 年月日(无时间)—— license 有效期/到期日(PL-R7)。
  date: { year: 'numeric', month: '2-digit', day: '2-digit' },
  // 年月日 时:分(24h)—— 需求元信息区(原手写 YYYY-MM-DD HH:mm)。
  full: {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  },
  // 含秒 —— automation 执行日志 / 下次运行(替代旧 `toLocaleString()`)。
  datetime: {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  },
}

export type NumberFormatName = 'integer' | 'decimal'

/** 命名数字预设。`integer` 走千分位分组(en `1,234` / ru `1 234`);`decimal` 保留至多两位小数。 */
export const NUMBER_FORMATS: Record<NumberFormatName, Intl.NumberFormatOptions> = {
  integer: { maximumFractionDigits: 0 },
  decimal: { style: 'decimal', minimumFractionDigits: 0, maximumFractionDigits: 2 },
}
