# agent-session — Cursor 能力边界

Cursor 与 Claude、Codex 落在同一套 driver / 审批桥 / 会话存储上([ADR 0011](../../../../architecture/adr/0011-vendor-neutral-agent-abstraction.md))。本页只记录**用户能做什么、不能做什么**;必须遵守的运行规则见 [规格](../agent-session-spec.md),协作与取舍见 [设计](../agent-session-design.md)。

## 相对 Claude / Codex

- **非托管宿主 CLI。** c3 不分发、不钉选 `cursor-agent`;只从部署覆盖与宿主 PATH 解析。找不到则该 agent 类型不可用。二进制名与 vendor 名不同,从厂商描述符读取([ADR 0012](../../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md)、[ADR 0040](../../../../architecture/adr/0040-cursor-as-host-cli-vendor.md))。
- **每轮一个子进程。** 不是常驻进程。中止是整轮终止,没有回合中途 interrupt,也不能把下一 turn 推进同一个存活进程。新会话的原生 id 在运行开始前已经铸出,绑定不必等第一帧。
- **无逐工具审批。** 权限在启动时一次定死;审批桥可注册但永不触发。
- **不能做 team lead。** 没有流式推入,AS-R21 直接排除。
- **无进程内 MCP。** c3 工具只经统一的回环 HTTP MCP,不为 Cursor 另开通道。
- **会话生命周期。** resume / list / read 为完整能力:读的是 CLI 与 Cursor IDE 共写的磁盘库,该工作区里发生过的会话都在,不限于 c3 创建的。rename / delete 为无:那是用户自己的 IDE 数据,c3 不改。
- **不接受图片。** 附图丢弃并告警,不让整轮失败。
- **线上仍是整段文本。** 适配器把增量收成一块再发出,下游按「一条文本 = 一条消息」读取。
- **凭据可选。** 填了 API key 就用,留空则用 CLI 写入操作系统钥匙串的登录态。不能指向其他 provider。

可用性走覆盖全部 vendor 的中立 `vendorRuntime` 信号,控制台不按「这是 Cursor」特判。已配好的 Cursor agent 在 CLI 暂时缺失时仍保持可选,避免 UI 悄悄改掉既有配置。

## 人机问答

Cursor 原生 `AskQuestion` 是 headless 下唯一的人机决策点。c3 把它接到与 Claude `AskUserQuestion` 同一条通道:`permission_request` 加逐题作答。允许后以同一原生会话续跑把答案交还模型;拒绝或停止不续跑。这是跨子进程模拟,不是 Cursor 的原生回合内输入,能力台账上的原生用户输入仍为假。

输入必须能变成可作答的问题列表;归一化失败以可见运行错误收束,不创建不可作答的请求,也不自动续跑。未回答的问题挡住意图 resume 与自动化继续,与 Claude 侧同一条「待回答问题」事实。

## 回环 MCP

CLI 只读工作区 MCP 配置,配置根与工作根不能分开。因此一轮期间把 c3 回环 MCP 叠加进该工作区配置,结束时还原;工作区自有条目保留。同一工作区第二个 Cursor 运行拒绝启动,以免两轮互相覆盖还原。叠加内容携带本轮绑定令牌,不得进入版本库。

## 模式

三档,启动时固定,经模式目录落到中立网格:计划(plan × 敏感时询问)、默认代理(build × 敏感时由 Cursor 自己分类)、全自动(build × 不再询问)。c3 已认定该目录就是本轮工作区,不再向 CLI 确认工作区信任。

## 消费面

Cursor agent 与其他真实 agent 走同一套选择、绑定与冻结规则:同厂商可换 agent,跨厂商拒绝。讨论参与者可以是 Cursor,研究会话的组织者仍只允许 Claude。自动化同样把 Cursor 当普通 vendor,不另开通道;CLI 缺失时在分派期结清,不改 automation 的 vendor,也不跨厂商回退。

会话数据根在沙箱内外同解,否则刚跑完的会话在列表里会消失。
