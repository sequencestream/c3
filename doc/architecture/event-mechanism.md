# 事件机制

跨特性的事实走同一条进程内类型化总线（[ADR-0018](adr/0018-event-bus-kernel-layer.md)）。系统形态见 [架构概览](architecture.md)。

发布者把发生的事投到主题，不关心谁在听。总线同步、按订阅序分发；发布者不等待消费者，单个订阅者出错不中止其余、也不回传到发布者。内核持有总线，不反向依赖特性或传输层。

内部主题承载 run / intent / agent 等生命周期。模型可发布的事实另走 `'event'` 主题，消费者按事件 `type` 判别。

## 模型对外发布表面

模型不能碰总线。唯一对外入口是 MCP 工具 `publish_event`：服务端按 `type` 归一化并补信封后，代模型发到 `'event'`。服务端自建 PR 成功后也经同一主题发出。

信封上的工作区与会话由当次 run 绑定，模型不可伪造。

### 字段级安全归一化

已知 type 走专用归一化器；未知 type 走默认归一化器——仍脱敏密钥与绝对路径、截断过长文本，且不改写 `type` 字符串。归一化失败则不发布。

## 模型可发布事件

模型可发布事件是开放的通用契约，配按 `type` 注册的归一化器（[ADR-0026](adr/0026-generic-event-normalizer-registry.md)）。工具面始终是同一个 `publish_event`：不是每种事件一个窄工具，也不是任意对象透传。

## 事件类型目录

`type` 为开放的 `<category>:<action>` 字符串，已知目录是建议而非封闭枚举（[ADR-0027](adr/0027-event-naming-and-multi-row-subscription.md)）。订阅可用 `<category>:*` 匹配该大类全部动作。

自动化按 type 订阅，过滤器为多行 OR 加 `:*` 大类通配；匹配与触发见 [automations](../domains/core/automations.md)。意图域对部分事件的消费见 [intent-management](../domains/core/intent-management.md)。
