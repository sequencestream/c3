# memory — 数据模型

以领域术语给出的实体定义;物理接线(SQLite 驱动、schema 收敛、索引)见
[memory-design.md](memory-design.md);表的列级语义见
[`database/memory/workspace_memories.sql`](../../../../database/memory/workspace_memories.sql)。
本域不上线协议,没有 wire 形状。

## WorkspaceMemory

一条记忆 = 一句可复述的结论。按工作区隔离。

- **`id`**(`string`(UUID)): 记忆唯一标识,同名覆盖时保持不变
- **`workspaceName`**(`string`): 所属工作区(引用 `workspaces.name`);每次读写的隔离边界
- **`subject`**(`string | null`): 归类标签;不参与身份判定,也不改变可见范围
- **`type`**(`MemoryType`): 四态闭集,见下
- **`title`**(`string`): 一句话标题,原样保留用户措辞;归一化后即这条记忆在本工作区内的身份
- **`content`**(`string`): 结论正文,非空且 ≤ 2000 个 Unicode 码点
- **`status`**(`MemoryStatus`): 三态闭集,见下
- **`sourceSessionId`**(`string`): 写下当前形态的 work session id(归因);每次写入刷新
- **`createdAt`**(`number`): 首次创建时间(epoch ms);同名覆盖不改变它
- **`updatedAt`**(`number`): 最近一次写入或状态变更时间(epoch ms);也是失效行 30 天回收期的起点
- **`supersededBy`**(`string | null`): 去重时指向留下的那条;目标被物理删除后置空

## MemoryType

`'preference' | 'constraint' | 'fact' | 'lesson'`。

- **`preference`** —— 用户偏好或习惯。「提交信息正文用中文」。
- **`constraint`** —— 已验证过的项目约束。「PR 合进交付分支,不是 main」。
- **`fact`** —— 稳定事实。「这个工作区的默认主分支是 main」。
- **`lesson`** —— 踩过的坑与教训。「沙箱内 vitest 需单线程,否则 Node 26 下 tinypool 崩」。

分型只影响目录呈现的分组,不改变任何权限或生命周期规则——唯一的例外是清理规则明确保护 `preference`
不因年龄被清除(见 [memory-spec.md](memory-spec.md))。

## MemoryStatus

`'active' | 'superseded' | 'deleted'`。

`active` 是普通检索唯一可见的状态。`superseded` 由去重产生(败者,`supersededBy` 指向留下的那条),
`deleted` 由软删产生。后两者是**恢复与清理**的关注点,不是模型上下文,并按各自的 `updatedAt` 满 30 天
后被物理删除。

三个状态之间没有「归档」态:一条记忆要么现在成立,要么被另一条取代,要么被显式删除。

## 归一化 title(身份判据)

身份是 `(workspaceName, 归一化 title)`。归一化 = 去首尾空白 → 内部连续空白折叠为单个空格 →
Unicode 小写。

它是**应用层比较键**,不属于上面的实体:`WorkspaceMemory` 不暴露它,调用方也从不传它。
物理层为它保留了一列(见 [memory-design.md](memory-design.md)),那是索引考量,不是模型扩张。

写入按这个键落到未 `superseded` 的行上即原地覆盖,这是本域**唯一**的自动语义判断。系统从不比较正文,
也从不询问 LLM 两句话是否矛盾——因此真正互斥的两条必须用不同 `title` 表达,可共用 `subject` 让分歧
可发现,两条都保持 `active`。归一化后同名的两条对立陈述在本版无法同时存在,这是确定性去重优先的
直接后果。

## MemoryScope

两个 MCP 工具闭包绑定的作用域,由服务端从 run 绑定派生,调用方无任何入参可以影响它。

| 属性            | 类型     | 来源                                               |
| --------------- | -------- | -------------------------------------------------- |
| `workspaceName` | `string` | run 绑定的工作区路径经 `workspaceNameFor` 解析所得 |
| `sessionId`     | `string` | run 的实时 id(pending→real 重绑后取新值)           |

这是工作区隔离成为结构性属性而非约定的原因:模型手里没有能指向另一个工作区的参数。

## 边界常量

| 常量                            | 值   | 含义                                               |
| ------------------------------- | ---- | -------------------------------------------------- |
| `MEMORY_MAX_CHARS`              | 2000 | 单个字段的 Unicode 码点上限(title/subject/content) |
| `MEMORY_MAX_ROWS_PER_WORKSPACE` | 500  | 单工作区物理行上限(含全部状态)                     |
| `MEMORY_RECOVERY_DAYS`          | 30   | 失效行被物理删除前的回收期天数                     |

## 拒绝类别

写入前的集中检查返回两类拒绝,拒绝信息只说类别与字段,从不回显命中的内容:

- **`credential`** —— 私钥块、bearer/访问令牌(GitHub / OpenAI / Anthropic / Slack / AWS / c3 外部 key
  形状)、JWT、以及带秘密样值的凭据赋值。
- **`artifact`** —— markdown 代码围栏、工具调用/返回的 XML 式框架、角色前缀的对话转录行、原始消息对象。

判据是**形状**,不是语义。散文里提到 `token`、`password`、`API key` 不构成拒绝;粘贴一段真实令牌或一段
代码块构成拒绝。
