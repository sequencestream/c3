# 0011 — 厂商中立的 Agent 抽象:三件套接口 + 能力台账

- **Status:** accepted
- **Date:** 2026-06-05
- **Amended:** 2026-06-07 — 能力台账扩展为包含结构化的会话生命周期能力状态(list / read / resume /
  rename / delete,每一项都是一个分级的能力状态)。矩阵与理由见下文"Capability ledger"下的
  _Amendment_ 段落。
- **Amended:** 2026-06-07 — 台账新增一个 task-store 能力标志(第 7 个布尔标志——当前三个厂商均为
  true)。适配层新增第 4 个中立接口:任务存储(create / list / update / get)。
- **Amended:** 2026-06-07 — Claude 任务存储的参考实现落地。见"Decision"下的 _Claude task store_
  段落。
- **Amended:** 2026-06-07(012)— 中立权限网格(action mode / tool gate)通过按厂商的模式目录,被
  提升为会话模式的 wire 表示。见 _Vendor mode catalog_ 段落。

## Context

在 ADR-0010 之前,c3 是一个仅支持 Claude 的产品:运行循环(run loop)直接导入 Claude Agent SDK,
权限网关(permission gateway)返回 SDK 的权限结果类型,会话历史直接从 Claude 的 transcript 中
读取,线路上的权限模式(permission-mode)值就是 SDK 五态联合类型本身。为支持不止一个厂商,我们
需要一个内核其余部分可以驱动的中立 agent 层,把每个厂商 SDK 的怪癖都封在其后。

三次 Phase-0 探针确立了任何中立接口都必须遵守的事实基础——各厂商**并不**共享同一种机制:

- **008(Codex)——单工具运行时批准 NO-GO。** Codex SDK 在派发一个回合(turn)后会关闭子进程的
  stdin;它的事件流是只读的,没有回写半信道,也没有"批准请求"事件。一个工具只能通过 abort 信号对
  **整个回合**进行允许/拒绝。没有可介入的循环内拦截点。
- 第三个厂商的批准是一次远程 REST 回写(`POST /session/{id}/permissions/{permissionID}`),需要一个
  Promise 桥接、一个超时默认拒绝(约 600ms)以及重连协调。它的生命周期是一个远程长驻服务,而非
  进程内子进程。
- **010(消息 diff)——公共集很窄。** 在三个厂商之间,只有会话 id 是无条件的公共字段;role
  (Codex 必须自行合成)和 blocks(追加式 upsert,而非整体携带)则是打折扣得来的。其余一切
  ("宁丢勿强塞")都归入厂商额外字段(vendor-extra)溢出区,而不是伪造一个顶层联合类型。

一个天真的"让所有人看起来都像 Claude"式接口,会对三个厂商都撒谎。ADR-0009 的边界规则(SDK 类型
永不离开内核,永不进入共享的 wire 契约)对我们选定的任何形态都必须同样成立。

## Options considered

1. **把 Claude 的类型放宽为共享接口。** 把权限模式、SDK 消息形态、逐工具批准回调都提升为中立
   接口。_Con:_ 把 Claude 的特有作风固化下来,而其他厂商无法遵从(Codex 没有逐工具批准;没有其他
   厂商有五态模式),而且把 SDK 类型拖向 wire 契约——直接违反 ADR-0009。
2. **一个要求所有能力都必备的胖接口。** 强制每个适配器都实现 interrupt / fork / 进程内 MCP /
   逐工具批准。_Con:_ Codex 物理上做不到逐工具批准(008);一个只能抛异常的必备方法,比一个缺失的
   方法更糟——上层无法区分,也就无法优雅降级。
3. **一个必备公共子集 + 一个针对所有分歧点的、经过探针验证的能力台账(选定)。** 三个中立接口
   (driver / approval / session-store),它们的*必备*接口面是每个厂商都能满足的,再加上一个由
   可选/可降级标志构成的能力台账,上层在触及某个有分歧的控制之前先检查它。权限收敛为一个正交的
   二维网格;SDK 值以 `unknown` 形式跨界,并在各厂商的适配器内部收窄。_Pro:_ 对探针结果诚实,把
   SDK 类型留在内核里,让上层可以按厂商各自降级。_Con:_ 增量阶段先让 Claude 适配器委托给既有的
   运行循环,而非替换它;把网关 + 运行循环都折叠进 driver 的完整重写留待后续阶段。

## Decision

采纳方案 3。建立一个厂商适配层,包含:

- **三个中立接口:**
  - **Agent driver** ——生命周期 + 流式的规范消息(canonical-message)迭代。必备:发起一次运行,
    以及在返回的 run handle 上:读取会话 id、迭代消息、abort。可选的运行控制(interrupt /
    set-action-mode / push-input / fork-session)仅在对应能力标志置位时才存在。
  - **Approval bridge** ——拦截 → 挂起 → 回写。必备:注册一个返回 disposer 的请求处理器。对于
    支持逐工具批准的厂商,该处理器按工具触发,裁决被回写;不支持的厂商则降级为启动时策略。
  - **Session store** ——最脏的耦合点(直接读取 transcript)被封在 list / read(返回中立的规范
    消息)之后,rename / delete 为可选。
- **中立权限策略**——给定一个工具名、其输入以及上下文,决定 allow / ask / deny。五态权限模式的
  1:1 映射被**放弃**;它收敛为两条正交的轴:一个 action mode(plan / build)× 一个 tool gate
  (always-ask / on-sensitive / trusted-prefix / never-ask)。每个适配器把自己原生的模式翻译到
  这个网格上(见下表);该网格永远无法 1:1 逆向还原(Claude `auto` 的偏向以及 `always-ask` 在
  Claude 侧没有对应项,都是被记录在案的损失)。
- **能力台账**——必备能力**没有标志**(它们就是接口契约本身);台账恰好持有七个**可选/可降级**
  标志:interrupt、set-action-mode、streaming-push、进程内 MCP、fork-session、逐工具批准
  (per-tool-approval)以及 task-store。第六项(逐工具批准)是在最初五个 Claude 专属控制项之外
  新增的,因为 008 证明了逐工具批准**并非**普适能力。第七项(task-store)是 SDK 任务工具面,当前
  三个厂商均为 true。
- **Amendment(本阶段)——结构化的会话生命周期能力状态。** 上述六个标志是诚实的布尔值(一个厂商
  要么有一个回合中途的 interrupt 点,要么没有)。**会话生命周期**操作(list / read / resume /
  rename / delete)则**不是**:008 证明了 Codex SDK 没有 listing/reading API;后来本地
  transcript 读取器让 Codex 的 rename/delete 存在于一个尚未接线的 REST 回写之后,而一个偶尔宕机
  的远程服务器也会呈现同样的形态。一个布尔值无法区分"没有"(结构性 NO)和"暂时不可用"(机制
  存在,当下不可达),而这个区别恰恰是 UI 必须呈现的。所以这些操作按每个 op 被诚实地分级为:
  none / partial / full / temporarily-unavailable,作为结构化的 session-capabilities 子台账挂在
  能力台账上。方法*契约*(每个厂商都在其 session store 上暴露 list/read)仍然是无条件的接口——
  方法总是*存在*,每个方法能交付什么则由台账诚实上报。一个自行上报分级的新厂商,在上层**零厂商
  分支**的情况下就能被正确降级。截至本次 amendment 的权威矩阵:

  | op     | Claude | Codex                   | remote |
  | ------ | ------ | ----------------------- | ------ |
  | list   | full   | full                    | full   |
  | read   | full   | full                    | full   |
  | resume | full   | full                    | full   |
  | rename | full   | temporarily-unavailable | none   |
  | delete | full   | temporarily-unavailable | none   |

  控制台按能力*状态*渲染 rename/delete 行按钮(none 隐藏,temporarily-unavailable 禁用,
  full/partial 启用)——一个降级函数,没有厂商分支。wire 在一个新的顶层
  session-capabilities-by-vendor 伴生字段上携带同一份矩阵(与 host 状态 / 绑定统计并列),与
  host-CLI 是否存在(能力 vs 可用性)正交。

- **规范消息模型**——依据 010:一个必备的厂商标签;会话 id 无条件;role / blocks / timestamp /
  turn id 打折扣;一个两级的 vendor-extra 溢出(envelope + block)。工具返回值被**内嵌**在
  tool-use block 上(一个 result 字段),按 id-upsert 回填——**没有**独立的 tool-result 规范
  block(D3 裁决维持;增量式厂商原地修订一个 block,Claude 的两段式拆分则向内折叠进这个模型)。

**权限翻译(供参考):**

| Source                     | → action mode        | → tool gate            |
| -------------------------- | -------------------- | ---------------------- |
| Claude `default`           | build                | on-sensitive           |
| Claude `auto`              | build                | on-sensitive(偏向丢失) |
| Claude `plan`              | plan                 | on-sensitive           |
| Claude `acceptEdits`       | build                | trusted-prefix         |
| Claude `bypassPermissions` | build                | never-ask              |
| Codex sandbox + approval   | sandbox ⇒ plan/build | approval policy ⇒ gate |

**Scope(决策 D1——仅增量):** 本阶段交付这些接口 + 一个**Claude 参考适配器**,委托给既有的运行
循环 / 权限网关 / 会话读取(不做改动);把线上网关折叠进 approval bridge 是后续阶段的事。

> integration(2026-06-06-003):一个受监督的服务端厂商,拥有循环外的逐工具批准和预批准审计。
> **Codex** 适配器以 c3 的**只读顾问席位**形式交付(2026-06-06-005),严格遵循 008 的 NO-GO
> 结论:能力台账**全为 false**(逐工具批准为 false),用启动时的 sandbox + approval-policy 网关
> 替代逐工具批准,一个运行时只读监视器 + 整回合 abort,以及每个工具项上一个结构性的预批准戳记
> (每一项都由 sandbox 网关自动允许,从不是 c3 的决策)。MCP-approval 兜底(§4 escape hatch 2)
> 保留为一个惰性骨架——Phase 0 判定它是一个狭窄的杠杆(无法拦截 Codex 内建的 shell /
> apply-patch)。Fork-session 保持 false:008 否决了原本要用 Codex 的 thread resume 作为 fork
> 的分支;那个 resume 转而服务于中立的会话 resume。
>
> **Codex 作为主驱动智能体(2026-06-06-007)。** 只读顾问的定位被**放宽**:一个 Codex 智能体
> 现在可以成为一个会话的主驱动方,而不仅是共识投票者。运行启动器通过一个受 host-binary 门控的
> 工厂来 fork 一次 Codex 运行。这**并未**推翻 008:仍然没有逐工具运行时批准(逐工具批准为
> false,approval bridge 从不触发)——启动时的 sandbox/approval 网关是被接受的替代方案。
>
> **Codex 策略源自默认模式,而非按 agent 各自配置(2026-06-06-008)。** 007 引入的按 agent 各自
> 的 sandbox/approval-policy 配置(及其相关管线)被移除。启动时网关的推导方式与每个厂商一致——
> 都源自会话的权限模式:会话默认模式 → 中立的 action-mode × tool-gate 网格 → Codex 策略翻译 →
> Codex 的 sandbox/approval-policy——因此一个权限开关驱动整张表,一个 Codex 智能体不需要单独的
> 权限配置。理由:中立网格已经表达了权限意图,而翻译早已作为兜底存在;007 的显式覆盖重复了这个
> 开关。可接受的权衡:`default` 的"敏感时询问"意图在 Codex 非交互式 exec 中没有实时信道,因此
> 退化为一个静态 sandbox(sandbox 才是真正的强制手段)。更严格的格子占主导——plan / always-ask
> → 只读。
>
> **上层领域对异构的容忍度(2026-06-06-006;2026-07-09 更新为共识)。** 能力台账同样约束着
> *上层*领域,厂商同质性曾是它们最初的组织原则:(1)**共识(consensus)**最初只在会话自身的
> 厂商内部投票。**已被取代(2026-07-09):** 被推迟的"风险标签中立化投票"现已建成——一个确定性
> 的服务端归一化器把一次工具请求映射为厂商中立的意图 + 风险载荷,因此共识现在可以**跨厂商**
> 投票,厂商范围标记也随之消失(PG-R13)。(2)**agent-teams** 被锁定在 streaming-push 能力
> 上——只有 Claude 能承载一个常驻 lead,因此一个非 Claude 会话永远不会升级为一个 team;
> (3)**降级链**只保留同厂商的兜底——不同厂商无法恢复上下文,因此跨厂商条目被跳过并上报。剩余
> 的、被推迟的跨厂商机制(异构队友、带 UI 标记上下文中断的 replay-seed 降级交接)仍停留在规格
> 阶段,未构建,直到出现真实需求。这里的原则是**诚实的 UI 优于伪造的能力**,而对共识而言,是
> **归一化为可比较的形态,而不是限制谁能参与**(PG-R13,AS-R21/R22)。

> **Claude 任务存储参考实现(2026-06-07)。** 第 4 个中立接口(任务存储)获得了它的 Claude 参考
> 实现,纯解析逻辑被拆分出来。Claude Agent SDK **没有编程式的单工具入口**——它内建的
> `TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet` 工具只在模型于一次 query 内调用它们时才会
> 运行——所以 Claude 任务存储是 SDK 任务系统的一个**影子(shadow)**:每个方法通过一个注入的
> 执行器驱动对应的 SDK 工具,并把解析后的结果折叠进一个内存中的影子 map(以任务 id 为键)。生产
> 环境的执行器委托给运行循环里的一个最小化一次性 query,指示模型恰好调用一个任务工具,同时禁用
> 其他所有工具,网关只自动允许被驱动的那个工具,**强制其精确的输入**(因此提示词无需 JSON
> 序列化——内核下的 JSON 序列化禁令,ADR-0009 R2,依然成立)。把 SDK 导入留在运行循环里(而非
> 适配层)保持了边界完整,正如 driver 委托给既有运行循环一样。
>
> SDK 把任务结果序列化为一个**字符串**,而非一个类型化对象,且确切格式没有被钉死(一个结构化
> 结果可能以序列化形式到达;创建确认是一行人类可读的话,如"Created task 1: …")。所以每个解析器
> 都是**双模**的——先 JSON,后文本正则兜底——并且**安全降级**:一个出错/乱码输出产生空/缺失
> 值,从不抛异常,影子保留最后一个良好状态(一次 list 解析失败**不是**一次清空,呼应 web 任务
> 列表"无法解析快照时保持现状"的规则)。Update 只返回一个确认,所以存储把这个补丁合并到它的影子
> 条目上,以返回一条完整的任务记录。一个实时的 update 推送信道被**省略**:它不存在,上层降级为
> 基于拉取的 list/get(探针协议)。该存储是**会话作用域**的(它把执行器绑定到一个
> cwd/model/env/resume 上下文),因此由上层按每个会话构建,而不是接到无参的、无状态的适配器
> 工厂上——与 interrupt / fork-session 虽然厂商为 true 但尚未作为运行控制暴露,是同一种增量
> 阶段的并行处理方式。测试是密闭的:执行器被 mock,不会派生 `claude` 进程,并覆盖 JSON+文本解析
> 矩阵以及影子合并/降级规则。

> **imperative**:Claude 存储*驱动* SDK 任务工具,所以 create / update / get 都做真实的工作。
> 增量式厂商则相反,暴露智能体自身正在运行的计划,c3 *观察*它但不撰写它。Codex 任务存储消费
> Codex 的 todo-list 线程条目——一个带文本/完成状态条目列表的稳定 list id,在 item 的
> start/update/complete 事件上重新发出一份**完整快照**(driver 把它映射为一条空的规范流,
> ADR-0013)。远程厂商的存储从会话 todo list 的一次 REST 全量拉取(一个 init 步骤)播种,然后
> 跟踪 todo-updated 事件。两个存储都是:list / get 服务于一个内存中的快照;update-push 信道是
> **实时推送信道**(存在 ⇒ 可选方法探针为 true,不同于 Claude 省略它);而 create / update 都会
> **拒绝**——两个厂商都不暴露一条写入智能体计划的外部路径,诚实原则(存在 ≠ 伪造)禁止伪造一条
> 出来。
>
> 三个映射决策。(1)**接入点是同一条信道,而非第二条流:** 两个存储都由 driver 自身的事件流
> (approval bridge 也被派发进这条流)喂入,所以只有一个连接、一次抖动恢复,而不是两条。测试
> 直接驱动这些接入点,密闭且无需进程/服务器。(2)**Id 合成(Codex):** 一个 todo 条目不携带
> id,所以一个稳定 id 由 list id + 下标合成(顺序是唯一稳定的抓手)。(3)**状态映射:** 原生
> 状态映射到中立的任务状态——cancelled → completed(不再活跃),任何未知值 → pending,两者都把
> 原始字符串保留在一个 vendor-extra 字段里;priority 搭载在一个 vendor-extra 字段上。每一帧/
> 事件都是一份完整快照 ⇒ 缓存被整体替换,update-push 只为**新增或变化**的任务(subject/status
> diff)触发,而非整个列表。和 Claude 存储一样,两者都是**会话作用域**的(绑定到一个会话/事件
> 流)并按每个会话构建。

> **Vendor mode catalog——token ⇄ 网格双向翻译(2026-06-07-012)。** 中立权限网格(action mode
> × tool gate)自 Phase 1 起就一直是内核内部的权限真值,但会话模式的 wire 表示仍然是 Claude 的
> 五值权限模式。这次泛化用一个**按厂商的 vendor mode catalog** 取代了它——它是某个厂商原生模式
> token 的单一事实来源。每个模式描述符把一个厂商的原生 token(例如 Claude 的 `plan`,一个
> Codex token)与它映射到的网格格子配对。通用的 token-to-grid / grid-to-token 辅助函数把这个
> 声明转化为每个适配器都需要的双向翻译。
>
> 三条设计规则成立。(1)**目录即接口,没有手写的 switch。** Claude 原先的权限映射被重构到由
> Claude 目录驱动的通用翻译器上;Codex 用同样的方式注册它的目录。一个按厂商的目录记录提供了
> 编译期的穷尽性钉子——新增一个厂商而不注册它的目录会导致类型检查失败。(2)**有损的逆向
> 翻译,但是安全的。** 网格 → token 方向挑选最接近的已声明 token(精确格子 → 相同 action
> mode → 默认 token),且永不跨越 plan/build 这条 action 边界。正向路径上一个未知 token 会
> 退化为该厂商默认 token 所在的格子——所以一个来自更早/其他厂商的存量 token 永远不会抛异常。
> (3)**Wire 始终携带该厂商的目录。** vendor-modes 这个 wire 字段把整份记录发给 web 端,控制台
> 读取当前活跃会话的厂商目录来标注模式并构建下拉菜单——与能力台账相同的按厂商、无分支的模式。

**Probe protocol。** 一个能力标志上报的是**厂商**能力。一个想要触及某个可选控制的调用方,需要
同时检查该标志**以及** run handle 是否确实暴露了这个方法(build-wiring 探针),二者有一个为
false 就降级。参考 Claude 适配器在本阶段接好了通过 run handle 可达的控制(set-action-mode、
push-input);interrupt / fork-session 虽然厂商为 true,但要等到重写阶段之后才会暴露。契约
测试钉住的不变量是那个安全方向:一个方法**存在 ⇒ 其标志为 true**(不存在没有对应能力的虚假
方法)。

## Consequences

- **Easier:** 一个新厂商添加一个实现三个接口并声明自己能力台账的兄弟适配器;上层通过中立接口
  驱动它,不带任何新的 Claude 假设。必备与可选的界线是机械地被检查的(一个契约测试钉住能力
  台账恰好是那七个可选标志,且必备接口面始终存在)。
- **Harder:** 中立权限网格比 Claude 的五种模式更粗;`auto` 的偏向以及一个 always-ask 网关在
  Claude 侧没有精确对应项(这些损失被记录在案,并在翻译处被暴露出来)。未来若某个 UI 想要找回
  丢失的细节,必须把它作为一个厂商额外字段重新引入,而不是塞进中立网格。
- **Boundary:** 没有任何厂商 SDK 类型出现在中立接口面或共享的 wire 契约里;SDK 值以 `unknown`
  形式跨界,并在各厂商适配器内部收窄。一个 grep 关卡强制此规则(见下文 Compliance)。
- **Migration:** 仅增量——既有的运行循环和网关不变,所以本阶段是一次纯粹的新增,所有既有行为
  保持完整。参考适配器是符合性见证;把 driver 变成*唯一*路径的运行循环重写,是一个独立的、
  可回退的阶段。

## Compliance

- Claude Agent SDK 的 import **不得**出现在共享 wire 契约中(SDK 永不进入 wire 契约)。grep
  针对的是 **import** 这种形式,而不是裸字符串——文档注释里的一句提及是允许的。
- Claude Agent SDK 的 import **不得**出现在厂商适配层中(SDK 类型永不到达中立接口面;适配器从
  `unknown` 收窄,或委托给既有的、在内核里做 SDK 收窄的代码,例如会话读取)。中立接口面只在
  一条边界规则注释里提到 SDK 的名字。
- 厂商适配层**不得** import features 层或 transport 层(ADR-0009 R1)。
- `pnpm typecheck` + `pnpm lint` **必须**为绿。
- `pnpm vitest run` **必须**为绿:厂商中立的契约钉住必备接口面 + 七个布尔标志 + 会话子台账;
  一个能力测试端到端地钉住权威的会话能力矩阵;Claude 符合性测试对参考适配器上报每个会话操作均
  为 full;web 会话列表按能力*状态*(none ⇒ 隐藏,temporarily-unavailable ⇒ 禁用,full ⇒
  启用)演练行操作门控,不带任何一处按厂商的分支。

## References

- [ADR 0009](0009-unidirectional-boundaries.md) —— 单向边界;本 ADR 把 SDK-永不离开内核这条
  规则扩展到中立接口面。
- [ADR 0005](0005-inherit-user-project-settings.md) —— c3 是权限网关(中立的 approval bridge
  把这个角色泛化到了所有厂商)。
- [agent-session spec](../../domains/core/agent-session/agent-session-spec.md) —— agent
  driver 所抽象的运行生命周期;中立网格所取代的权限模式表。
- Phase-0 探针:`changes/2026/06/05/2026-06-05-008-codex-approval-probe/`(NO-GO)。
- 本阶段的 spec:`changes/2026/06/05/2026-06-05-011-vendor-neutral-agent-abstraction/2026-06-05-011-vendor-neutral-agent-abstraction-spec.md`。
