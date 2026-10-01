# session-registry — 设计

实现[规格](session-registry-spec.md)。本域不驱动运行，也不渲染侧边栏；它是工作区与会话的目录。

## 协作

**agent-session.** 播种工作目录、每会话模式与 resume id。pending 绑定时把真实 id 交回 runtime；选择会话时从原生存储取基线，再叠 runtime 缓冲。运行是否存活、状态如何广播，由 agent-session 拥有（[ADR 0006](../../../architecture/adr/0006-decouple-runs-from-connections.md)）。

**web-console.** 消费 `workspaces` / `sessions` / `session_selected`，发送登记与选择。控件如何排布由控制台拥有。目录点选发出 `select_workspace_directory`；选择发生在服务端所在机器，没有图形界面则改由用户填写路径。

**files.** 只读浏览以已登记工作区名解析根路径。本域提供名称到路径的映射，不解释相对路径。

**厂商原生存储.** 转录、标题与存在性的事实来源。目录投影可从各厂商枚举重建。重命名与删除能做多少，取决于该厂商会话存储的能力。

**其他写入方.** 意图、讨论、自动化等在绑定时声明投影行的种类与所有者。本域按声明列目录，不推断「谁启动的」。

## 关键取舍

**投影，而不是每次扫原生存储。** 目录与角标走可重建投影，避免每次打开侧边栏扫描所有厂商磁盘。代价是绑定与落定必须刷新近期程度，后台创建必须扇出，否则新会话会沉底或只被一个连接看见。转录仍只在原生存储，c3 不双写（[ADR 0013](../../../architecture/adr/0013-canonical-envelope-on-wire-c3-session-namespace.md)）。

**查看不是所有权。** 连接只记住正在看谁；运行活在进程里。切换与关闭 socket 不停止运行；删除会话或移除工作区才停。工作区从目录拿掉仍保留身份与磁盘转录，避免配置变孤儿、历史被误删（[ADR 0004](../../../architecture/adr/0004-persist-workspace-session-registry.md)）。

**只持久化本域元数据。** 工作区身份、最近访问、每会话模式、最后活跃提示。权限决策不落盘。实例库不可用则空目录启动，进程仍能起来（[ADR 0042](../../../architecture/adr/0042-configuration-in-database.md)）。

## 非功能

跨会话无固定上限。过期的模式条目读取时忽略。列表分页，不把整个目录一次性推给客户端。
