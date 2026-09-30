# web-console — 设计

实现[规格](web-console-spec.md)。本域不拥有运行、目录或权限决策；它是人对这些事实的视图。

## 协作

**session-registry.** 消费 `workspaces` / `sessions` / `session_selected`，发送登记、选择与增删改名。当前工作区是本机记住的导航上下文，与「正在看哪条会话」解耦；切工作区不停止运行、不擅自改正在看的流。路径点选由注册表在服务端主机完成。

**agent-session.** 消费活动流与 `session_status`，发送 `user_prompt` / `set_mode` / `stop_run` / `set_session_agent`。连接只订阅当前查看的会话；切走或刷新靠回放接回同一条流（[ADR 0006](../../../architecture/adr/0006-decouple-runs-from-connections.md)）。非 team 会话单 turn；本域用客户端队列向用户隐藏这次拒绝。

**permission-gateway.** 消费 `permission_request` 与 `consensus_auto`，回 `permission_response`。待决跟 run 走；切走视图仍可按 `requestId` 作答。控件如何排布由本域拥有。

**settings.** 控制台打开系统、工作区与个人化配置面并发送读写；字段、门禁与冷启动里的智能体/运行时门由那些域规定。

意图、讨论、自动化、自更新各自拥有账本与动作；控制台提供窗口、深链、进度遮罩与更新胶囊。

## 关键取舍

**队列藏起单 turn 拒绝。** 服务端对非 team 仍拒绝进行中的 `user_prompt`。队列只活在本机、按会话、刷新即丢。只刷出「正在看且已 idle」的队列，因为 `user_prompt` 打到当前视图。

**连接是视图，不是运行所有者。** 切走、关 socket 或刷新必须能回到同一条流。代价是未发出的队列与草稿不持久化；运行与待决权限仍在进程里。

**桌面与移动是两套信息架构。** 桌面用常驻工作区列表与系统入口并列；窄屏改分层进入，把输入留在软键盘与安全区之上。同一套动作，不是同一套版面。

## 非功能

刷新丢失队列与未发出的草稿。连接断开后自动重连并恢复当前视图。错误必须对人可见，不得静默。
