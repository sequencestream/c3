# Relay 架构

进程内 provider 枢纽：能自定义上游的厂商 CLI，其 provider 流量发到本进程 loopback，由 relay 换发认证、适配协议、在同组候选间故障转移。决策见 [ADR-0029](adr/0029-vendor-neutral-relay-and-agent-group-failover.md)。系统形状见 [architecture.md](architecture.md)。

Claude 与 Codex 走 relay。Cursor 不走——c3 没有 Cursor 协议的中继，该厂商恒为 CLI 自身登录（[ADR-0040](adr/0040-cursor-as-host-cli-vendor.md)）。

## 为什么走 loopback

真实 provider 密钥只存在 c3 进程内，永不离开。厂商 CLI 只持有 **per-run 不透明 token**；relay 按 token 取出有序候选，用真实密钥出站。run 结束注销。未知 token 拒绝。无组的智能体是长度为 1 的候选，与组共用同一路径。

沙箱内同样只见 token 与 loopback，够到宿主回环上的 relay。隔离边界见 [sandbox](../domains/core/sandbox.md)。

## 组与故障转移

相同 `(group, vendor)` 的启用智能体构成一组，在选择面上暴露为虚拟组智能体。组身份含 vendor，跨厂商不转移。档案与角色绑定见 [agent-config](../domains/settings/agent-config.md)。

一次请求从当前段最高优先级候选起试；**仅在尚未向 CLI 回传任何响应字节之前**失败才切下一个。开始流式后上游中断，该请求以错误结束。命中候选的真实 model 由 relay 覆盖，CLI 侧 model 只作占位。组内候选应同档——relay 做连接级转移，不消除模型差异。

组内可混经提供方（走 relay）与 CLI 自身登录。二者不能在同一次 run 内切换。

## 启动段与会话游标

provider 端点在进程拉起时写入，一次 run 无法在「走 relay」与「CLI 自身登录」之间切换。候选按 relay 可达性切成启动段：段首可经 relay，则段含其后紧邻的连续可 relay 成员；段首不可 relay，则段只含它自己，该 run 用 CLI 登录。**段首一定被使用**——可见顺序即运行顺序。

段内转移由 relay 负责。跨段由会话游标承担：记录下次启动从组内哪个成员起算；run 因可降级错误失败后推进到下一段，组为环，越过末尾回绕；游标指向已离组成员时退回自然顺序；重新绑定智能体清空游标。决策见 [ADR-0037](adr/0037-group-launch-segment-and-session-cursor.md)。

## 协议适配

适配按厂商、按候选上游协议选择透传或翻译；无 SDK 类型穿过翻译层（[ADR-0009](adr/0009-unidirectional-boundaries.md)）。Codex 在上游为 Chat 时做 Responses↔Chat 双向翻译，上游为 Responses 时透传。Claude 对 Anthropic 兼容上游透传。relay 不做跨协议的 Claude 翻译，也不做厂商之间的切换。共识投票不在本层。
