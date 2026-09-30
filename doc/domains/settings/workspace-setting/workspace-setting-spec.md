# workspace-setting — 领域规格

## Overview

workspace-setting 按工作区名称持有一份独立配置。缺失或部分条目回退规范化默认。智能体引用留空表示继承,不把当时的系统值快照进来。

**范围:** 智能体覆盖、按厂商默认权限模式、开发与 Git、沙箱启用与挂载种类、共识旋钮与讨论上限、规格策略、自动化总闸与并发、外部技能仓库、代码托管;本机观测与访问一览两个只读面。
**边界:** 不执行隔离(见 [sandbox](../../core/sandbox/sandbox-spec.md));不解析角色(见 [AC-R33](../agent-config/agent-config-spec.md));不编排共识(见 [permission-gateway](../../core/permission-gateway/permission-gateway-overview.md));不跑讨论(见 [discussion](../../core/discussion/discussion-spec.md));不调度自动化或意图队列;不编辑账号范围(见 [system-setting](../system-setting/system-setting-spec.md#用户与访问));不拥有钥匙或记忆账本。

能力索引见 [features.md](../../../features.md) 的 workspace-setting 节。持久化分层见 [settings 组概览](../settings-overview.md)。

## Business rules

### 智能体覆盖

默认、工作角色与七类专用角色均可覆盖系统。空值继承,省略键,不快照。解析先后、组路由、运行时与种子的分工见 [AC-R33](../agent-config/agent-config-spec.md) / [AC-R34](../agent-config/agent-config-spec.md) / [AC-R35](../agent-config/agent-config-spec.md)。系统保存时清理全部工作区悬空引用。

### 默认权限模式

新会话按厂商读取本工作区默认权限模式([AC-R8](../agent-config/agent-config-spec.md))。各厂商对照自己的目录;非法或缺失回退该厂商缺省,不把别家缺省写入这家。会话已持久化但不在目录内的模式,下发前降为工作区默认。Codex 的无边界写入须有显式授权标记,不从沙箱档反推;无标记则降为工作区可写。此后按会话改模式不回写本域。

### 开发与 Git

开发启动可带一条斜杠命令前缀,空则无。分支策略为当前分支或独立工作树,缺省工作树;非法归一为工作树。工作树以指定基准分支分叉,缺省从当前 HEAD。

### 工作区沙箱

工作区自身的进程隔离配置:是否启用、补充挂载、哪些会话种类入箱。缺省关;种类缺省仅工作会话。是否入箱只看启用与种类,与 run 来源、是否工作树、分支模式无关。切换分支模式不丢已存配置。补充挂载默认只读,不得覆盖执行根、源工作区、规格目录。运行语义见 [sandbox 规格](../../core/sandbox/sandbox-spec.md)。本域不按名称引用系统沙箱模板。

### 共识与讨论

权限共识含是否启用、一致或多数、投票者集,缺省关。编排见 [permission-gateway](../../core/permission-gateway/permission-gateway-overview.md)。每阶段轮次上限最小 8,每轮字数引导最小 300,均向上钳制。值由本域持有([AC-R9](../agent-config/agent-config-spec.md));引擎见 [discussion 规格](../../core/discussion/discussion-spec.md)。

### 规格策略

规格驱动开发总开关缺省开,仅显式关闭。机器批准显式 opt-in、缺省关,仅显式开启才落键;高影响仍强制人工(见 [RM-R51](../../core/intent-management/intent-management-spec.md))。关闭不撤销已批准。见 [ADR-0032](../../../architecture/adr/0032-machine-spec-approval-opt-in.md)。

小改动阈值约束 `fast` 单回合改动的文件数与行数,缺省 3 与 50,达到即超阈。超阈后的闸门见 [RM-R43](../../core/intent-management/intent-management-spec.md)。

规格根不是配置项:服务端从工作区路径解析,只读展示,客户端提交忽略。不入 Git。不识别工作区内历史规范文档。

### 自动化策略

自动派发总闸缺省开,仅显式关闭。挡住此后自动派发,不改单条状态、不影响立即运行(见 [SCH-R28](../../core/automations/automations-spec.md))。读取失败按开。

队列同时开发的意图数上限缺省 2、最小 1,只约束自动派发的开发会话。共享检出有效并发恒为 1(见 [RM-A12](../../core/intent-management/intent-management-spec.md))。规格阶段不计入。人工与外部启动不按此配额拒绝。调低不取消在途。

### 外部技能仓库

外部 git 仓库作为技能源。空则本工作区无外部技能。配置不合法则拒绝保存。

### 代码托管

建 PR/MR 所用托管:自动探测,或显式 GitHub / GitLab。缺省自动。

### 本机观测

只读展示本工作区挂起后恢复情况,不进配置、不进保存。本机、不出网,无导出或遥测入口。空样本与查询失败分示,失败优先于旧数字。迟到回包按工作区名丢弃。采集口径见 [RM-A23](../../core/intent-management/intent-management-spec.md)。

### 访问一览

只读列出当前谁能到达本工作区,不进配置、不进保存。名单与外部调用闸门同一解析器。能到达本工作区的已认证连接可读;不能到达、未认证或不存在,回同一种拒绝。不生成、不吊销、不改范围。语义见 [external-mcp](../../core/external-mcp/external-mcp-spec.md);账号范围编辑见 [system-setting](../system-setting/system-setting-spec.md#用户与访问)。

## Domain events

消费 `load_workspace_setting`、`save_workspace_setting`、`get_workspace_accessors`、`get_park_recovery_stats`。发出 `workspace_setting`、`workspace_accessors`、`park_recovery_stats`。形状见[共享协议](../../../shared/api-conventions/websocket-protocol.md)。观测与访问不进保存载荷。

## Interactions

- **agent-config** — 覆盖存储;解析在该域。
- **sandbox** — 启用、补充挂载、种类勾选。
- **permission-gateway** — 共识旋钮。
- **discussion** — 轮次与字数上限。
- **automations / intent-management** — 总闸、并发、规格策略、Git、托管。
- **external-mcp / system-setting** — 访问一览只读求交。
- **web-console** — 设置页。UX 不是权威。
