# Domain: workspace-setting

- **Group:** settings
- **One-line:** 按工作区持有的配置旋钮:智能体覆盖、默认权限模式、开发与 Git、沙箱启用、共识与讨论、规格与自动化策略。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [agent-config](agent-config.md)(档案与覆盖解析);[session-registry](../core/session-registry.md)(工作区名称);[external-mcp](../core/external-mcp.md)(访问求交);[system-setting](system-setting.md)(账号范围)。
- **Depended on by:** [sandbox](../core/sandbox.md)(启用、挂载、种类);[permission-gateway](../core/permission-gateway.md)(共识旋钮);[discussion](../core/discussion.md)(轮次上限);[automations](../core/automations.md)(总闸);[agent-config](agent-config.md)(工作区覆盖);[intent-management](../core/intent-management.md)(规格与并发);[web-console](../core/web-console.md)(设置页)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0032](../../architecture/adr/0032-machine-spec-approval-opt-in.md) 机器批准显式 opt-in

本域拥有按工作区名称持久化的旋钮。隔离运行见 [sandbox](../core/sandbox.md);角色解析见 [agent-config](agent-config.md)。观测与访问一览只读、不进保存。

## Overview

workspace-setting 按工作区名称持有一份独立配置。缺失或部分条目回退规范化默认。智能体引用留空表示继承,不把当时的系统值快照进来。

**范围:** 智能体覆盖、按厂商默认权限模式、开发与 Git、沙箱启用与挂载种类、共识旋钮与讨论上限、规格策略、自动化总闸与并发、外部技能仓库、代码托管;本机观测与访问一览两个只读面。
**边界:** 不执行隔离(见 [sandbox](../core/sandbox.md));不解析角色(见 [AC-R33](agent-config.md));不编排共识(见 [permission-gateway](../core/permission-gateway.md));不跑讨论(见 [discussion](../core/discussion.md));不调度自动化或意图队列;不编辑账号范围(见 [system-setting](system-setting.md#用户与访问));不拥有钥匙或记忆账本。

## Business rules

### 智能体覆盖

默认、工作角色与七类专用角色均可覆盖系统。空值继承,省略键,不快照。解析先后、组路由、运行时与种子的分工见 [AC-R33](agent-config.md) / [AC-R34](agent-config.md) / [AC-R35](agent-config.md)。系统保存时清理全部工作区悬空引用。

### 默认权限模式

新会话按厂商读取本工作区默认权限模式([AC-R8](agent-config.md))。各厂商对照自己的目录;非法或缺失回退该厂商缺省,不把别家缺省写入这家。会话已持久化但不在目录内的模式,下发前降为工作区默认。Codex 的无边界写入须有显式授权标记,不从沙箱档反推;无标记则降为工作区可写。此后按会话改模式不回写本域。

### 开发与 Git

开发启动可带一条斜杠命令前缀,空则无。分支策略为当前分支或独立工作树,缺省工作树;非法归一为工作树。工作树以指定基准分支分叉,缺省从当前 HEAD。

### 工作区沙箱

工作区自身的进程隔离配置:是否启用、补充挂载、哪些会话种类入箱。缺省关;种类缺省仅工作会话。是否入箱只看启用与种类,与 run 来源、是否工作树、分支模式无关。切换分支模式不丢已存配置。补充挂载默认只读,不得覆盖执行根、源工作区、规格目录。运行语义见 [sandbox](../core/sandbox.md)。本域不按名称引用系统沙箱模板。

### 共识与讨论

权限共识含是否启用、一致或多数、投票者集,缺省关。编排见 [permission-gateway](../core/permission-gateway.md)。每阶段轮次上限最小 8,每轮字数引导最小 300,均向上钳制。值由本域持有([AC-R9](agent-config.md));引擎见 [discussion](../core/discussion.md)。

### 规格策略

规格驱动开发总开关缺省开,仅显式关闭。机器批准显式 opt-in、缺省关,仅显式开启才落键;高影响仍强制人工(见 [RM-R51](../core/intent-management.md))。关闭不撤销已批准。见 [ADR-0032](../../architecture/adr/0032-machine-spec-approval-opt-in.md)。

小改动阈值约束 `fast` 单回合改动的文件数与行数,缺省 3 与 50,达到即超阈。超阈后的闸门见 [RM-R43](../core/intent-management.md)。

规格根不是配置项:服务端从工作区路径解析,只读展示,客户端提交忽略。不入 Git。不识别工作区内历史规范文档。

### 自动化策略

自动派发总闸缺省开,仅显式关闭。挡住此后自动派发,不改单条状态、不影响立即运行(见 [SCH-R28](../core/automations.md))。读取失败按开。

队列同时开发的意图数上限缺省 2、最小 1,只约束自动派发的开发会话。共享检出有效并发恒为 1(见 [RM-A12](../core/intent-management.md))。规格阶段不计入。人工与外部启动不按此配额拒绝。调低不取消在途。

### 外部技能仓库

外部 git 仓库作为技能源。空则本工作区无外部技能。配置不合法则拒绝保存。

### 代码托管

建 PR/MR 所用托管:自动探测,或显式 GitHub / GitLab。缺省自动。

### 本机观测

只读展示本工作区挂起后恢复情况,不进配置、不进保存。本机、不出网,无导出或遥测入口。空样本与查询失败分示,失败优先于旧数字。迟到回包按工作区名丢弃。采集口径见 [RM-A23](../core/intent-management.md)。

### 访问一览

只读列出当前谁能到达本工作区,不进配置、不进保存。名单与外部调用闸门同一解析器。能到达本工作区的已认证连接可读;不能到达、未认证或不存在,回同一种拒绝。不生成、不吊销、不改范围。语义见 [external-mcp](../core/external-mcp.md);账号范围编辑见 [system-setting](system-setting.md#用户与访问)。

## Domain events

消费 `load_workspace_setting`、`save_workspace_setting`、`get_workspace_accessors`、`get_park_recovery_stats`。发出 `workspace_setting`、`workspace_accessors`、`park_recovery_stats`。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。观测与访问不进保存载荷。

## 协作

**agent-config.** 工作区默认与角色覆盖存在本域;该域按 AC-R33 / AC-R35 解析。权限模式与讨论上限不在该域。

**sandbox.** 启用、挂载、种类在本域;该域只执行。配置不随分支模式删除。

**permission-gateway / discussion.** 共识旋钮按工作区身份读取,不按本次运行的工作目录。轮次与字数上限由本域持有。

**automations / intent-management.** 总闸、并发、规格策略、Git、托管。工作台可开关同一总闸。

**external-mcp.** 只读展示求交结果。不是授权入口。

**web-console.** 渲染设置页。

## 关键取舍

**继承省略键,不快照。** 空值跟随上级;写入当时系统值会冻住继承。

**机器批准只落开启。** 缺省与关闭都不写键,未显式开启的工作区没有这条路径。见 [ADR-0032](../../architecture/adr/0032-machine-spec-approval-opt-in.md)。

**沙箱是工作区上的隔离配置,不是系统模板。** 启用、挂载、种类跟工作区走。

**观测与访问不进保存。** 派生统计与求交名单若进保存载荷,会被回写成配置,或显得本页能改授权。

**并发默认 2。** 未配置的工作树工作区否则会一次拉起大量会话;共享检出仍恒为 1。

**Codex 完全访问是授权事实。** 从沙箱档反推会把普通配置当成自我授权。

持久化失败则该工作区回退规范化默认。观测不出本机。
