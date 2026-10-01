# 沙箱架构

入选 run 的厂商 CLI 作为宿主进程运行,由 arapuca 用内核 MAC 收窄可见目录。不是容器,没有独立根文件系统;进程看见的绝对路径即宿主路径,无 bind 改写。决策见 [ADR-0028](adr/0028-process-level-lightweight-sandbox-arapuca.md)。隔离不变量与协作见 [sandbox](../domains/core/sandbox.md)。

## 进程级隔离

容器更强,但对日常 run 过重:路径要映射、真钥要下沉、回环服务要旁路。进程级消解这三处——同路径、真钥不进箱、回环即本机。隔离弱于容器,不承诺不可信代码的强隔离。

隔离不可用则该 run 失败,永不裸跑。

门控是工作区启用加会话种类,与意图来源、工作树、分支模式无关;见 [workspace-setting](../domains/settings/workspace-setting.md)。[IM 机器人](../domains/core/im-robot.md) 每回合无条件隔离。

## 网络

只控目录允许/拒绝,不收窄出站网络。进程即宿主,回环 MCP 天然可达。

## 凭证

不向箱内注入供应方真钥。自备连接只见 [relay](relay-architecture.md) 令牌;订阅态开宿主钥匙串。认证边界见规格与设计。
