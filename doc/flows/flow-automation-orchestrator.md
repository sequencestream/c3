# Flow — 自动化编排器

**场景。** 用户在想要构建的意图上勾选 `automate`,然后点击自动化按钮。一个按项目划分的后台
循环按优先级/依赖顺序逐一开发它们,评判是否真正完成,提交并推送,然后推进——一旦出现异常
终止就记录下原因并停止。

**领域。** intent-management · agent-session · permission-gateway · git。

这是 [意图 → 开发](flow-intent-to-development.md) 的**无人值守**版本兄弟流程。它是“不自动
完成”规则(`RM-R9`)唯一一个显式的、用户主动选择加入的例外:只有在一个独立的评判者确认**且**
变更已被提交并推送(`RM-A5`)之后,它才会把一个意图标记为 `done`。自动化是**受监督的**,而非
无人值守:一次实时的权限 prompt 会等待一位正在盯着的人类(`RM-A9`)。

## 流程图

```mermaid
flowchart TD
    START[start_automation] --> GATE[concurrency gate]
    GATE --> PICK[pick eligible<br/>priority → oldest]
    PICK -- none left --> DONE[finish done]
    PICK --> ACT[start action<br/>attach / resume / fresh]
    ACT --> DEVT[dev turn — gated, supervised]
    DEVT --> J{completion judge}
    J -- done --> CP[commit & push · mark done]
    J -- in_progress --> CONT[continue ≤ cap]
    J -- stuck --> STOP[stop · reason recorded]
    CONT --> DEVT
    CP --> PICK
    STOP -. majority toggle .-> CC[checkpoint consensus<br/>may override]
```

## 启动与排序

1. **web-console → intent-management。** `start_automation`。每个项目最多同时运行**一个**
   编排器；第二次启动是空操作,只会返回当前的运行状态(`RM-A2`)。编排器存在于内存中,不会在
   服务器重启后存活(`RM-A2`)。
2. **全局并发闸门。** 在挑选下一个意图之前,若该项目中**任何**一个 `in_progress` 的意图
   (包括手动启动的)有一个**真正在运行**的工作会话,编排器会附加一个内部查看者,并等待那一轮
   结束再重新检查——以防止并发的开发会话在文件写入上发生冲突(`RM-A12`)。一个**悬空
   (dangling)**的会话不会阻塞。
3. **挑选。** 符合资格的条件是:`automate` 为真,且 `status ∈ {todo, in_progress}`,且所有已知的
   `dependsOn` 都是 `done`;在 worktree 模式下,若某个 `done` 依赖的 PR/MR 尚未确认为
   `merged`,则依然会阻塞,因为其代码是否已进入主干尚不确定。当工作区启用了 SDD
   (`sddEnabled`)时,该意图还必须通过规格审批检查点(`spec_approved=true`)。SDD 关闭时保持
   历史行为,不要求有规格。若唯一使某个意图不符合资格的原因是某个依赖的 PR/MR 状态陈旧且未
   确认,服务器会启动一次一次性的后台 PR/MR 状态同步,完成后重新检查;它不会轮询,也不会绕过
   该闸门。符合资格的意图按**优先级(P0→P3)再按最旧优先**排序(`RM-A3`)。`dependsOnIndexes`
   的提交顺序戳记(`RM-R17`)会确定性地打破同优先级的平局。

## 开发一个意图

启动动作遵循严格的优先级次序(`RM-A3`、`RM-A10`):

1. **Attach(附加)**——若被选中意图的 `lastWorkSessionId` **已经在运行某一轮**,附加并跟踪它
   (绝不启动第二轮——一次运行会比一轮更长命,`RM-A10`)。
2. **Resume(恢复)**——否则,若一个 `in_progress` 意图的 `lastWorkSessionId` **仍存在于磁盘上**,
   则恢复它(`resume` id,`AS-R1`/`AS-R10`),延续其半成品的 dev-skill 上下文。
3. **Fresh(全新)**——否则,一个 `todo` 或**悬空**的意图会启动一个全新的工作会话(可配置技能),
   与手动启动相同的悬空规则(`RM-R8`)。

开发轮次运行标准的受门控循环。**权限一致性**(`RM-A9`):该轮次中出现的一次 prompt 行为与手动
会话完全一致——该次运行**不会**被中止;它停在 `awaiting_permission`,该 prompt 呈现给浏览器,
一位正在盯着的人类回答后,该轮次继续。与此同时状态会显示一个“等待授权”的提示。

## 评判 → 提交 → 推进

1. **完成度评判(`RM-A4`)。** 该轮次结束后,一个**不带工具**的一次性评判者读取该意图 +
   工作会话最后一条助手消息 + 代码变更证据(跨多仓库的 `git diff`/`git log` 仅作为*佐证性*
   旁证,**不是** `done` 的先决条件),返回 `done` / `in_progress` / `stuck`,判定优先级依次
   为 **stuck → done → in_progress**。轮次结束本身绝不等同于“done”;空的证据本身也绝不单独
   构成 `stuck` 信号。
2. **`done` ⇒ 提交并推送(`RM-A5`)。** 编排器提交任何未提交的工作(`feat: <title>`,若工作树
   干净则跳过),并**总是**推送(感知多仓库),然后把该意图标记为 `done` 并推进。若提交被
   **pre-commit lint 钩子**拦截,会通过单次开发智能体修复轮次自愈,再重试一次(`RM-A13`);
   任何其他提交/推送失败(或修复后仍然存在的 lint 失败)都是硬性停止(`RM-A6`)。
3. **`in_progress` ⇒ 继续(`RM-A8`)。** 用一次 continue 恢复同一会话(清除各检查点),直到达到
   一个固定的单意图上限;超出该上限即为异常停止。continue 仅用于**纯粹的检查点**,绝不用于
   回答一个人工决策点。
4. **`stuck` ⇒ 停止(`RM-A6`)**,原因记录在自动化按钮旁边。
5. **耗尽。** 当没有符合资格的意图剩余时,该循环以 `done`(成功)结束;`stop_automation` 会
   中止当前运行,并无错误地返回 `idle`(`RM-A7`)。

## 分支 —— 检查点共识override(`RM-A14`)

当多数票开关(`ConsensusConfig.majority`)为 ON 时,一次 `stuck` 判定或一个
`pendingQuestion` 守卫可能改为触发一次多智能体投票(通过共享的跨厂商
`selectConsensusVoters` 选出的对等方,一次性、禁用工具;continue/wait 的 prompt 与厂商无关,
且跳过工具风险归一化器),来决定是否通过该检查点。多数票 `continue` 会覆盖该次停止并
自动继续(与 `RM-A8` 相同的上限);平票 / 多数为 `wait` 则停止(`RM-A6`)。结果通过
`AutomationStatus.checkpointConsensus` 广播。它只决定*自动化流程*本身,绝不决定底层
`AskUserQuestion` 的答案。参见
[consensus(共识)](../domains/core/permission-gateway/features/permission-gateway-consensus.md)。

## 自动化 c3 MCP 工具集

编排器执行环境(每个 `llm_prompt` 类型的自动化运行)绑定一个受限的 c3 MCP 服务,暴露以下
工具(与手动 WebSocket 路径相同的行为,但以 MCP 返回值表达结果):

| 工具名                     | 类型 | 说明                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `find_intents`             | 只读 | 按 status/module/keyword 检索项目意图列表                                                                                                                                                                                                                                            |
| `view_intent`              | 只读 | 按 id 查看单条意图完整详情                                                                                                                                                                                                                                                           |
| `save_intent_pr_info`      | 写   | 回填意图的 PR 状态(由 PR 对账自动化使用)                                                                                                                                                                                                                                             |
| `save_intent_directly`     | 写   | 直接落库新建草稿意图(绕过人工确认,仅限自动化)                                                                                                                                                                                                                                        |
| `publish_pr_event`         | 写   | 发布 PR 操作事件(触发其他自动化)                                                                                                                                                                                                                                                     |
| `find_discussions`         | 只读 | 检索项目讨论列表                                                                                                                                                                                                                                                                     |
| `view_discussion`          | 只读 | 查看单条讨论详情及消息                                                                                                                                                                                                                                                               |
| `start_discussion`         | 写   | 启动一个 draft 讨论                                                                                                                                                                                                                                                                  |
| `continue_discussion`      | 写   | 继续或恢复一个讨论                                                                                                                                                                                                                                                                   |
| `start_session_for_intent` | 写   | **按意图启动 spec 或 work 会话**。接受 `intentId` + `sessionType`(`'spec'` / `'work'`),复用与手动操作一致的校验门禁(状态、SDD 审批、依赖阻塞、Git 分支策略)。成功返回 JSON `{sessionId, sessionType}`,失败返回 JSON `{code, params}` 且 `isError: true`。不发送 WebSocket 进度事件。 |

工具列表源是 `AUTOMATION_C3_TOOL_NAMES`——所有表面(Claude SDK、Codex HTTP)自动同步,
无需维护第二份名单。

## 分支与异常(反面场景)

- **人工决策点绝不会被碾过。** `stuck` 涵盖每一种“需要人类介入”的信号(`RM-A11`)。在此之上,
  一个独立的 `pendingQuestion` 守卫会强制停止一个**已拆除**且带有未回答的 `AskUserQuestion`
  的轮次——**即便**评判者判定为 `in_progress`(`RM-A11`,纵深防御)。
- **轮次结束 ≠ 完成。** dev skill 是由检查点驱动的;一次单纯的轮次结束绝不会被当作 `done`
  (`RM-A4`)。
- **缺乏证据绝不否决一份可信的报告。** 提交是 c3 在 `done` *之后*的工作,因此一个空的
  diff/log 本身绝不能否定完成(`RM-A4`/`RM-A5`)。
- **受监督而非无人值守。** 若无人在盯着,一次 prompt 可以无限期等待;要完全无人值守运行,
  必须通过 mode/allow 规则预先授权(`RM-A9`)。
