# session-registry — 数据模型

实体与不变量。行为见[规格](session-registry-spec.md)，协作见[设计](session-registry-design.md)。线上形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义，此处不重复。

## Workspace

一个已登记的项目目录。身份是不可变的工作区名称；路径是该智能体的工作目录，也是会话枚举所依据的位置，不是身份。

不变量:

- 名称全局唯一、创建后不可变；路径指向已存在的目录，且同一路径只对应一个身份。
- 按最近访问排序；在其中选择或创建会话会推高自己。
- 从目录取消登记不删除身份、配置或磁盘转录；同一路径再登记时恢复原名称。
- 零个或多个 Session。

## Session

工作区内一次由厂商托管的对话。对外以不透明 c3 会话 id 寻址（[ADR 0013](../../../architecture/adr/0013-canonical-envelope-on-wire-c3-session-namespace.md)）。

真实种类：`work` / `intent` / `spec` / `spec_review` / `discussion` / `automation` / `tool` / `robot`（及内部 `consensus`）。会话页按显示分类列目录，「规范」同时含 `spec` 与 `spec_review`；`robot` 不进会话页。

不变量:

- 转录、标题与存在性由所属厂商的原生存储拥有；本域拥有目录成员资格与权限模式。
- 所有者是跳回指针，不是意图 / 讨论 / 自动化等域的事实来源。
- 种类与所有者由写入投影的调用方声明；本域不因启动机制改写它们。
- 厂商在首次绑定时冻结，之后不能改。

## Pending Session

在 UI 中创建、尚未首次运行的会话。历史为空；首次运行绑到真实 Session，意向变为事实。从未运行则只留下可变意向，不产生真实会话。
