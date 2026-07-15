# 0007 — 只读意图沟通智能体；经工具确认后保存；跨运行时 SQLite

- **Status:** accepted
- **Date:** 2026-05-30
- **传输修订(2026-07-15):** c3 自己工具面的传输被**统一**——两个厂商(Claude 与 Codex)现在都
  通过**同一条回环 streamable-HTTP MCP 路由**到达这些工具(原先 Claude 走进程内 SDK MCP、Codex 走
  回环 HTTP MCP 的双轨已合并)。`alwaysLoad` 的意图现在表达为 HTTP MCP 配置的 `alwaysLoad: true`
  (工具在 turn-1 常驻,无需 ToolSearch 往返)。本 ADR 的处理器持有的保存确认、默认拒绝的 spec
  只读网关等安全不变量保持不变;仅传输被统一。下文的 `createSdkMcpServer` / 进程内 MCP 措辞已
  更新为当前状态。

## Context

意图管理特性为每个项目新增一份意图台账,以及一个长驻智能体,帮助用户把想法拆解为可验证的意图项。该智能体必须能够
**读取**项目内容以进行良好推理,但必须**永不**修改项目——它是一个规划/分析界面,不是一个编码会话。持久化一条意图
必须是一个刻意的、由人类确认的动作,并且该台账必须同时在 Node CJS bundle 与 Bun 单体二进制下工作,而这两者暴露的
是不同的内置 SQLite 模块。

有三个决策足够耦合,值得一并记录:

1. 如何让沟通智能体真正做到只读(而不仅仅是被指示要只读)。
2. 如何只在人类明确确认后才持久化一条意图。
3. 如何在两个拥有不同 SQLite 驱动的运行时之间存储该台账。

## Options considered

1. **仅靠系统提示做到只读。** 告诉智能体不要写入。_缺点:_ 无法强制执行——模型仍然可以调用 `Write`/`Bash`,
   或衍生一个会写入的子智能体或 slash 命令,而提示词无法阻止它。作为*唯一*机制被否决。
2. **在工具层做只读 + 默认拒绝的网关(采用)。** 禁用所有写入/执行/编排类工具,并在 `canUseTool` 处拒绝任何
   意料之外的调用,同时仍放行纯粹*交互式*、没有写入副作用的工具(`AskUserQuestion`)。_缺点:_ 必须让禁用清单
   与网关保持与 SDK 工具面同步,并对每个新工具做写入 vs 交互的分类。_优点:_ 纵深防御;SDK 新增的写入类工具
   即便未列入禁用清单,依然会被网关的默认策略拒绝。
3. **由自由形式的智能体动作保存(自动持久化)。** _缺点:_ 没有人类检查点;违反"由人类决定"的立场,且有台账
   混入垃圾数据的风险。被否决。
4. **通过复用权限网关的确认流程来保存(采用)。** 一个 save-intents 的
   MCP 工具经由既有的 `canUseTool` → `permission_request` 流程路由;只有在用户允许之后,写入才会在工具
   处理器中发生。
5. **通过第三方 npm 驱动内置 SQLite。** _缺点:_ 原生绑定会使 Bun 单体二进制复杂化;与内置模块重复。被否决。
6. **通过运行时内置模块之上的一层薄驱动适配器实现 SQLite(采用)。** Node 上用 `node:sqlite`,Bun 上用
   `bun:sqlite`,置于同一个由 `globalThis.Bun` 选择的最小同步接口之后。

## Decision

同时采纳选项 2、4、6。

- **只读在工具层被强制执行,且双重上锁。** 沟通运行会禁用所有写入/执行类工具——`Write`/`Edit`/`MultiEdit`/
  `NotebookEdit`/`Bash`/`BashOutput`/`KillShell`——外加 **`Task`** 与 **`SlashCommand`**——后两者至关重要,
  因为子智能体的工具调用会绕过父级的 `canUseTool`,而 slash 命令可能触发写文件的技能。在此之上,该运行的
  `canUseTool` 网关**默认拒绝**:读取类工具自动放行,save-intents 这个 MCP 工具**被放行至其处理器**(由处理器
  自行发起确认——见下文"保存"一节),`AskUserQuestion` 被放行(经由回答注入路径——见下文),其余一律拒绝——
  因此即便未来 SDK 出现一个不在禁用清单内的写入类新工具,依然会被拦下。这套读取类自动放行集合,除读取内置
  工具(`Read`/`Grep`/`Glob`/`LS`/……)之外,还包括**两个只读的 c3 意图查询 MCP 工具**(`mcp__c3__find_intents`
  与 `mcp__c3__view_intent`)——它们只读取该智能体*自身*项目的台账(在工具构造时就绑定到项目,与保存工具
  一样),因此不带任何写入/执行副作用,也不需要确认。网关的工具路由是一个纯函数、有单元测试覆盖的分类器,
  把每个工具映射到 allow / ask / deny 三者之一。
  - **这两个只读查询工具同样服务于 spec 编写会话。** spec 会话(写入范围被限定在其 spec 目录内;意图管理规格
    RM-R21 / RM-R27)被赋予**相同的** `find_intents` / `view_intent` 工具,以便作者能够把 spec 建立在既有意图
    的事实基础上——但**永不**给予 `save_intents`(spec 会话不得写入台账)。为了避免把保存网关的依赖拖入
    spec 路径,这里用的是一个**独立、更小的**只读工具面,只注册这两个只读工具(而不是对意图服务器做
    过滤复用)。绑定项目 + 只读 + `alwaysLoad` 这三点完全一致。spec 权限网关的读取放行集合是一个**明确**的
    只读并集(读取内置工具 ∪ 这两个查询工具),因此 `save_intents` 在那里会落入**默认拒绝**,即便它被误注册
    或被厂商预先批准也是如此——这与意图网关不同,意图网关是刻意把保存放行给处理器自身持有的确认。Claude
    与 Codex 的 spec 会话都通过**同一条回环 HTTP MCP 路由**拿到相同的双工具集(Claude 边界把中立描述符
    转译为 SDK 的 HTTP MCP 配置,Codex 的 `enabled_tools` 由该精简集合派生),两个厂商都不含 `save_intents`。
- **`AskUserQuestion` 作为*交互式*而非*写入*工具被放行。** 它只是向人类提出澄清性问题,不带任何文件/执行/
  编排类副作用,因此让只读智能体向用户提问并不违反只读的立场——这与智能体已有的人机对话是同一回事,只是被
  结构化了。因此它被**排除在禁用清单之外**,并由网关放行。它*不是*一次简单的放行:SDK 只有在工具输入本身
  已经带有答案时才会回显答案,因此网关会通过 `permission_request` 提示人类,并在允许时把带有已注入答案的
  输入返回(取消则拒绝)。它**不经过共识**运行(单一智能体,没有投票方),一个空的/无效的问题集合会落到
  默认拒绝。
- **沟通运行被强制置于 `permissionMode: 'default'`**(一个*辅助性*约束,不再是防止静默持久化的主要防线——
  见下文"保存"一节)。对该运行,`set_mode` 会被忽略,界面也不显示模式选择器。
- **保存确认位于保存处理器内,而非 `canUseTool`。** save-intents 动作(一个 c3 MCP 工具,
  `mcp__c3__save_intents`)最初由 `canUseTool` 把关——但厂商自身的权限规则引擎可以*预先批准*某个工具,从而
  **完全跳过 `canUseTool`**(例如一条匹配 `mcp__c3__save_intents` 的用户/项目允许规则,或非 `default` 的权限
  模式)。这使得该确认可被绕过,并让一次保存悄无声息地持久化。因此确认网关被**下沉到保存处理器自身**:处理器
  发出同样的 `permission_request` 线上帧,阻塞等待用户决定,只有在 `allow` 时才持久化。因为网关如今是处理器
  的*唯一执行点*——只要该工具被调用就一定会经过这里,厂商的规则只能决定*是否*调用它——它对每一种预先批准途径
  都免疫。这同时**让两个厂商收敛到同一个网关**:两个厂商都经由同一条回环 HTTP MCP 路由调用意图工具
  (在任何 `canUseTool` 之外),因此都在处理器内部把关。因此意图网关会把保存
  *放行*至处理器(没有 `confirm-save` 分支);在拒绝/失败时,处理器向智能体报告一个错误结果,台账不受影响。
- **保存工具被固定常驻(`alwaysLoad`)。** c3 自己的工具面对两个厂商都走同一条回环 HTTP MCP 路由;在
  Claude 边界,中立描述符被转译为 Claude SDK 的 HTTP MCP 配置(`{ type: 'http', url, alwaysLoad: true }`),
  `alwaysLoad: true` 让工具在 turn-1 常驻。否则,harness 的工具搜索会延迟加载该 MCP 工具,智能体必须在
  每次保存前用 `ToolSearch` 把保存工具的 schema 取回来——这在热路径上是额外的往返与 token 成本。`alwaysLoad`
  只让**schema** 保持常驻;它并**不**绕过网关——保存处理器仍然会发起人类确认。作用范围仅限于意图智能体,因为 c3 的
  工具面只在意图智能体的启动路径上被绑定。同一路由上承载的那两个只读查询工具,出于同样的理由继承了
  `alwaysLoad`——智能体在检查相关意图之前不应该还得先把它们 ToolSearch 回来。
  - **限制(已记录,尚无法解决):** 智能体同时使用的内置工具(`AskUserQuestion`、`Read`/`Grep`/`Glob`/`LS`)
    在 `@anthropic-ai/claude-agent-sdk` 0.3.158 中**没有**常驻加载的开关——`ToolConfig` 只暴露了
    `askUserQuestion.previewFormat`,`Options` 中也没有全局的工具搜索开关。所以这些工具可能仍会被延迟在工具
    搜索之后。**重新审视的触发条件:** 当 SDK 提供内置工具的 `alwaysLoad`(或 `Options` 级别的工具搜索开关)
    时,把常驻范围以同样方式扩展到只读/交互类内置工具集合。
- **该台账使用一个跨运行时的 SQLite 驱动适配器。** 一个最小的同步接口(execute / run / all-rows /
  single-row)根据 `globalThis.Bun` 在 `bun:sqlite` 与 `node:sqlite` 之间做选择;二者永不交叉。适配器只使用
  位置型 `?` 占位符,并按字段名读取行。打包器必须把两个模块都标记为 `external`(仅靠动态 import 无法满足
  打包器的要求)。位于 `~/.c3/c3.db` 的存储会软失败:在打开/创建失败时,意图相关特性按接入点各自降级,c3
  仍能正常启动。

## Consequences

- **更容易:** 沟通智能体可以自由读取仓库,同时在结构上无法修改它;持久化始终经过用户已经熟悉的同一套人类
  确认;该台账在 Node 与 Bun 两种构建下都能开箱即用,没有原生依赖。
- **更难:** 禁用清单与网关默认策略必须随 SDK 不断演进的工具集一起维护;强制 `default` 这条规则是意图运行时
  必须始终保留的一个特例;两种 SQLite 驱动面(占位符/行形状的差异)必须始终留在适配器之后;esbuild 配置要
  携带两个必须的 `external` 条目。
- **复用,而非新机制:** 没有新的权限传输通道——保存确认就是既有的
  `permission_request`/`permission_response` 这对消息,只是前端渲染做了特化。

## Compliance

- 沟通运行 MUST 禁用写入/执行/编排类工具(含 `Task`/`SlashCommand`),应用意图网关的默认拒绝策略,并运行在
  `permissionMode: 'default'` 下(一个辅助性约束——保存确认已不再依赖它)。评审者应拒绝任何允许其写入、衍生
  子智能体、或运行 slash 命令的路径。
- 一条意图 MUST 只能在 save-intents 工具处理器内部、在人类允许之后被持久化,且保存确认 MUST **由该处理器**
  发起(而不仅仅由 `canUseTool` 发起),这样即便厂商的预先批准跳过了 `canUseTool`,依然会触发提示。任何代码
  路径都不得绕过该确认写入台账,且意图网关 MUST NOT 额外再为保存弹出提示(它把保存放行给处理器——重复提示
  是一种回退)。两个厂商 MUST 共享这一个由处理器持有的网关。
- 只读查询工具 MUST 在构造时绑定项目(永不信任线上传来的项目),且 MUST 被网关自动放行、无需确认;它们是
  只读的,不得写入台账。评审者应拒绝任何让它们读取另一个项目、或把它们变成写入/确认工具的路径。
- spec 编写会话 MUST 只被赋予这两个只读查询工具(不含 `save_intents`),并绑定项目。Claude 与 Codex 都通过
  **同一条回环 HTTP MCP 路由**拿到相同的精简工具列表。spec 权限网关 MUST 只放行一个明确的
  只读集合(读取内置工具 ∪ 这两个查询工具),使得 `save_intents` 在那里默认被拒绝。评审者应拒绝给 spec 会话
  任何写入台账的工具、跨项目读取、或完整的意图 MCP 路由。
- c3 的 MCP 服务器 MUST 让保存工具保持常驻(`alwaysLoad: true`),使其不被延迟在工具搜索之后。评审者应拒绝
  移除 `alwaysLoad`,也应拒绝把它解读为一种权限放宽——它只固定 schema;网关确认本身不受影响。
- `AskUserQuestion` MUST 留在禁用清单之外,并被意图网关作为一个交互式(非写入)工具放行,但只能经由答案注入
  路径(提示人类、在允许时注入答案、取消则拒绝)——绝不是一次简单的放行。评审者应拒绝把它当作写入工具处理
  (过度限制),也应拒绝把它当作自动放行的读取工具处理(那样注入的答案会丢失)。
- SQLite 驱动 MUST 由 `globalThis.Bun` 选择;`node:sqlite` 与 `bun:sqlite` MUST 对打包器都标记为 `external`。
  该存储 MUST 软失败,使 c3 在没有它的情况下依然能启动。

## References

- [intent-management spec](../../domains/core/intent-management/intent-management-spec.md)
- [intent-management design](../../domains/core/intent-management/intent-management-design.md)
- [permission-gateway spec](../../domains/core/permission-gateway/permission-gateway-spec.md) —— 被复用的
  `canUseTool` 流程。
- [ADR 0006](0006-decouple-runs-from-connections.md) —— 沟通运行与开发运行共用的运行时注册表。
- [WebSocket protocol](../../shared/api-conventions/websocket-protocol.md) —— `permission_request`、
  `permission_response`、`select_session`,以及新增的意图消息。
