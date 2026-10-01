# Domain: memory

- **Group:** core
- **One-line:** 工作区级记事本:工作会话跨轮次记下偏好、约束与教训,设置页可查阅并软删。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [session-registry](session-registry.md)(工作区身份);[agent-session](agent-session.md)(工作会话与工具面)。
- **Depended on by:** [permission-gateway](permission-gateway.md)(工作会话上预批准);[workspace-setting](../settings/workspace-setting.md)(查阅与软删)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。模型侧仅工作会话工具 `memory_search` / `memory_write`;不进外部 MCP 目录。
- **ADRs:** [0045](../../architecture/adr/0045-workspace-memory-as-allowed-local-persistence.md) 工作区记忆为被允许的本地持久化

本域拥有工作区记事本。它存结论,不存转录。仓库能自证的事实属于仓库文档;会话里说出、不宜写进仓库的共识落在这里。正式术语见[术语表](../../glossary.md)。

## Overview

memory 把用户口头表达过的偏好、验证过一次的项目约束、稳定事实与教训留给以后的工作会话,使同一件事不必再说一遍。它存结论,不存转录。

**范围:** 工作会话上检索与写入、工作区设置页查阅与软删、同名即一条、写入边界、软删后到期清除。
**边界:** 不是账号级、不跨工作区;不自动读、不启动注入;设置页不写;不是密钥库;不做语义检索;不从意图、交付、仓库或厂商会话回填。不进外部 MCP 目录。

## Business rules

### 检索与写入

仅工作会话可调用 `memory_search` / `memory_write`。种类正向选中 `work`,其它会话拿不到。标准权限门对二者免确认;免确认不等于可用。作用域由服务端从该次运行的工作区绑定派生,调用方给不出另一个工作区。

检索不注入上下文。无检索词返回本工作区 `active` 目录;有词则对本工作区 `active` 条目做字面匹配。不跨工作区,不退到失效行,不改写成语义检索。

写入一次只做一次变更:`create` / `update` / `delete`。成功回报实际保存或删除的标题。失败则无部分变更;写入不被静默丢弃、截断或改写成别的类型。

- **M-R3**: 每次读写以工作区为边界。跨工作区的标识一律视为不存在。分组标签不扩权。
- **M-R8**: 存储不可用时检索返回空、写入显式失败。失败的写入绝不回报成功。

### 设置页查阅

工作区设置可列出本工作区 `active` 摘要并逐条软删,经 `list_workspace_memories` / `delete_workspace_memory`。不提供新建、编辑或检索。列表不含正文——正文只在工作会话里读。删除与工作会话的删除同一语义。未知工作区拒绝;没有账号级或跨工作区入口。列表在存储不可用时为空,删除则显式失败。

### 同名与矛盾

- **M-R1**: 身份是 `(工作区, 归一化标题)`。归一化去首尾空白、折叠内部空白并转小写。同名写入原地覆盖,并可复活已软删的同名条目。这是本域唯一的自动语义判断。
- **M-R2**: 系统不比较正文,也不问模型两句是否矛盾。真正互斥的两条必须用不同标题,两条都保持 `active`。改成已占用标题则拒绝,不合并。

### 写入边界

- **M-R4**: 单字段 ≤ 2000 个 Unicode 码点;单工作区 ≤ 500 行(含全部状态)。覆盖已有标题不占新槽。超限拒绝,不淘汰任何已有记忆。
- **M-R5**: 凭据形状与产物形状(代码围栏、工具调用/返回框架、角色转录行)一律拒绝;拒绝不回显命中内容。形状检测挡不住任意散文,本域不是密钥库。

### 软删回收

- **M-R6**: 删除改状态为 `deleted`,不立即擦除。`superseded` 与 `deleted` 自变更起满 30 天再清除。回收期内仍占容量。
- **M-R7**: 清理不读正文、不问模型。同工作区同归一化标题只留最新一条,其余标 `superseded`;失效行过回收期物理删除。`active` 永不因年龄删除。

## Domain events

消费 `list_workspace_memories`、`delete_workspace_memory`。发出 `workspace_memories`、`workspace_memory_deleted`。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。模型侧工具不是 WebSocket 帧。

## 数据模型

### Memory

工作区级的一条持久结论:用户偏好、已验证约束、稳定事实或教训。身份是 `(工作区, 归一化标题)`。作用域由服务端从工作会话绑定派生,调用方不能指向另一个工作区。

不变量:

- 类型为 `preference` | `constraint` | `fact` | `lesson`,只影响目录分组,不改变权限或生命周期。
- 状态为 `active` | `superseded` | `deleted`。普通检索与设置页列表只见 `active`。`superseded` 不可再改。没有归档态:一条记忆要么现在成立,要么被另一条取代,要么被显式删除。
- 同名即一条。真正互斥的结论用不同标题。
- 设置页只见摘要,不见正文。正文的读取属于工作会话。
- 凭据形状与代码/转录产物不得写入。
- 字段与工作区容量有上限;删除先改状态,满回收期再清除。回收期内仍占容量。`active` 不因年龄消失。

## 协作

**agent-session.** 仅在工作会话挂载 `memory_search` / `memory_write`,走既有工作会话 MCP,不另开路由。种类正向选中 `work`,新增会话种类默认拿不到。各厂商工作会话共用同一工具面;工具名从已注册集派生,避免某一厂商静默丢掉未点名的工具。

**permission-gateway.** 两个记忆工具在工作会话上预批准,不发 `permission_request`、不走共识。预批准不是可达性。

**session-registry.** 工作区名称是隔离键;路径在本域不作为身份。

**workspace-setting.** 渲染查阅与软删;不提供写。按钮是窗口,闸门以服务端为准。

## 关键取舍

**本地记事本,不是云同步。** 记忆是被允许的本机结构化持久化,不是把对话或代码送出本机。写进仓库会污染 diff 并跨人泄漏;从台账反推需要语义判断,本域不做。见 [ADR 0045](../../architecture/adr/0045-workspace-memory-as-allowed-local-persistence.md)。

**免确认换可逆。** 维护高频,风险已被字段闭集、上限、拒绝规则与软删压住;逐次弹窗只会训练人盲点。代价是只有工作会话能写,且设置页可纠偏。

**字面检索,不淘汰。** 不做向量或矛盾检测。容量满时拒绝新条目,不静默丢掉用户说过的话。

## 非功能

存储不可用则读空、写失败。失败必须对人可见。失效行由进程内定期按规则清除;清理失败则下次再试,不提前删除。
