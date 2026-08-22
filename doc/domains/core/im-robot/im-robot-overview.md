# 领域: im-robot

- **分组:** core
- **一句话:** 把 c3 的 agent 能力延伸到办公 IM——群里 @机器人 提问,c3 在机器人自己的目录里跑一轮无人值守会话,把最终回答发回群里;这是 c3 唯一一条主动把 agent 产出送往第三方云的路径。
- **负责人:** maintainer
- **状态:** 活跃
- **依赖:** 位于 `~/.c3/c3.db` 的本地 SQLite 存储(`im_robots` / `im_robot_threads` / `im_robot_context_turns` / `im_robot_turns`);`agent-session` 的 run 生命周期(`robot` 会话种类 + 无人值守回合);`permission-gateway` 的 `robot` 门;`agent-config` 的 vendor 与 agent(含组引用)解析;服务端统一出站 HTTP 通道与代理解析。
- **被依赖方:** 无。没有其它域读取机器人数据。
- **exposes-api:** true —— 七条 WebSocket 消息(名册读写、启用、外发确认、回合审计),不新增 HTTP 路由,不进外部 MCP 工具目录。
- **ADRs:** [0046](../../../architecture/adr/0046-im-robot-outbound-authorization.md)、[0047](../../../architecture/adr/0047-robot-local-reads-scoped-to-run-root.md)、[0048](../../../architecture/adr/0048-robot-im-context-as-bounded-local-persistence.md)、[0049](../../../architecture/adr/0049-im-identity-and-call-level-scope.md)

## 它解决什么

c3 的人机界面只有浏览器。可日常协作发生在 IM 里:一个问题在群里被提出,答案却要有人切到另一个窗口去问、
再切回来复述。im-robot 域把那一步去掉——问题在哪里被提出,答案就回到哪里。

它不是把 c3 搬进聊天窗口。机器人回答问题,不替代控制台:过程、工具调用与授权决策仍然只在 c3 里。

同一群中的不同发送者各自拥有互不相通的连续对话;可恢复上下文以数据库为事实源,按发送者隔离
(ADR-0048),避免跨用户引用他人历史。

## 边界

- **不绑工作区 / 部署级出入口。** 配置、连接与名册跨工作区一致;运行目录 `~/.c3/robots/<name>/`
  是隔离的工作容器,不是授权范围或默认工作区,也不进工作区注册表、不出现在会话页。部署级全局 ≠
  无边界访问:工作区/对象/用户权限不得从机器人、连接、`threadKey` 或 `sessionId` 推断。否决工作区内
  机器人与连接/线程级工作区绑定。正式术语见[术语表·机器人](../../../glossary.md)。
- **发送者隔离。** Conversation 身份是 `(platform, robotId, threadKey, senderId, bindingId, subject, scope_hash)`。IM 发送者须先完成 Web→私聊身份绑定;未绑定只收固定引导。`scope_hash` 单调反映授权版本,绑定/撤销/ACL 变化会切断旧上下文。不提供同群共享上下文;需要共同背景时,各发送者须在自己的消息中显式提供。
- **能力上限 L0–L3。** L0 受控播报、L1 只读问答、L2 定向作答、L3 高风险写入只回 Web 深链——这是
  天花板与后续设计约束,不是当前启用清单;不因此提前开放身份绑定、主动播报或聊天写动作。本地写工具
  白名单仍受运行根与沙箱约束,不等于 L2/L3 业务权限。
- **默认停用,启用是一次独立的授权动作。** 创建不启用;启用需要管理员、需要凭据、需要一次记录在案的
  外发范围确认。缺任何一条,服务端拒绝启用。
- **只发最终回答。** 工具调用、工具结果、中间推理、文件内容一概不外发——这是结构性的,不是开关。
- **唯一出站守卫。** 所有最终回复只经平台中性受控发送入口;supervisor 拿不到可直发的 sender。
- **只读运行根。** 本地文件读取只在 `~/.c3/robots/<name>/` 内放行:判定基于真实路径(符号链接、`..`
  均按实际解析结果),越界在读到之前被拒,门与执行前钩子双重强制(宿主 settings 绕不开)——「只发最终
  回答」因此不靠出站守卫事后拦。
- **不在群里问权限。** 群里没有人能回答授权对话框,所以权限在配置时冻结;面向人的交互工具被门直接拒绝。
- **默认只读。** 写/执行能力必须由管理员逐个列举。
- **响应面默认收敛。** 群消息默认必须 @机器人,单聊默认不响应。
- **不做平台特性。** 不发卡片、不上传文件、不做流式改写;回答是一段文本。
- **不承诺内容安全。** 入站与出站守卫挡得住常见凭据形状,挡不住任意散文。
- **IM 身份绑定与调用级作用域。** Web 本人发起挑战、私聊消费令牌;未绑定只收固定引导。Conversation 含 `scope_hash`; L1 只读工具每次调用重算个人范围 ∩ 群白名单。

## 索引

- [im-robot-spec.md](im-robot-spec.md) —— 一条消息的完整判定链、授权规则、失败语义、审计规则
- [im-robot-design.md](im-robot-design.md) —— provider 抽象与飞书实现、supervisor 生命周期、回合执行路径、代理处理
- [im-robot-models.md](im-robot-models.md) —— Robot / Conversation / Context Turn / Turn 实体与其判据
