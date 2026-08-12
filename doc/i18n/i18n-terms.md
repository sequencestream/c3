# 术语表与禁译表(i18n 译法冻结)

> 适用范围:前端 UI 文案的多语种翻译。本清单是**译法冻结点** —— 同一术语在所有 locale
> 中必须用此处的固定译法,翻译评审(AI/人校)与一致性校验闸后置校验均以本清单为准。
> 配套命名规范见 [`i18n-spec.md`](./i18n-spec.md);术语定义见 [`../glossary.md`](../glossary.md)。

## 1. 术语表(固定译法)

同一术语**只允许一种译法**,不得在不同 key 间漂移。`zh` 为 M1 首发译法;`ja`/`ko`
为 M2 第二批译法;`ru` 为 M3 末批译法(均为机翻 + 母语校对前的基准译法,人校可在此
基础上微调并回写本清单)。

- **Allow** — zh 允许 · ja 許可 · ko 허용 · ru Разрешить
  - 权限决策动作,与 Deny 成对
- **Deny** — zh 拒绝 · ja 拒否 · ko 거부 · ru Запретить
  - 权限决策动作,与 Allow 成对
- **Session** — zh 会话 · ja セッション · ko 세션 · ru Сессия
  - c3 会话域(见 glossary)
- **Automation** — zh 自动化 · ja 自動化 · ko 자동화 · ru Автоматизация
  - c3 自动化域;域名固定;cron 触发子标签仍用 schedule 义(排期/スケジュール/일정/Расписание)
- **Discussion** — zh 讨论 · ja ディスカッション · ko 토론 · ru Обсуждение
  - c3 讨论域
- **Delivery** — zh 交付 · ja デリバリー · ko 딜리버리 · ru Доставка
  - c3 交付域(交付作为集成单元,ADR-0036;域名固定)
- **Intent** — zh 意图 · ja 意図 · ko 의도 · ru Намерение
  - c3 意图域(正名;原 Requirement 改名而来)
- **Permission** — zh 权限 · ja 権限 · ko 권한 · ru Разрешение
  - 权限请求/决策;permission mode = «режим разрешений»
- **Settings** — zh 设置 · ja 設定 · ko 설정 · ru Настройки
  - 系统设置 = «Системные настройки»
- **Agent** — zh 智能体 · ja エージェント · ko 에이전트 · ru Агент
  - 多 agent 共识场景;若指代工具/系统标识符则不译
- **Consensus** — zh 共识 · ja 合意 · ko 합의 · ru Консенсус
  - 多 agent 共识
- **Workspace** — zh 工作区 · ja ワークスペース · ko 작업 공간 · ru Рабочая область
- **Cancel** — zh 取消 · ja キャンセル · ko 취소 · ru Отмена
- **Save** — zh 保存 · ja 保存 · ko 저장 · ru Сохранить
- **Submit** — zh 提交 · ja 送信 · ko 제출 · ru Отправить
- **Create** — zh 新建 · ja 新規作成 · ko 새로 만들기 · ru Создать
- **Completed** — zh 已完成 · ja 完了 · ko 완료 · ru Завершено
- **Created** — zh 已创建 · ja 作成済み · ko 생성됨 · ru Создано
- **Depends on** — zh 依赖 · ja 依存 · ko 의존 · ru Зависит от
- **Base** — zh base · ja base · ko base · ru база
  - 依赖闸门语境下指「本次会话开发所基于的分支」,中文保留 base 不译(译成「基线」会与 worktree 基线混淆)
- **Sync mainline** — zh 同步主线 · ja メインラインを同期 · ko 메인라인 동기화 · ru Синхронизировать основную ветку
  - 交付集成期把 origin/<base_branch> 合入交付分支的人工动作
- **Force-release** — zh 强制放行 · ja 強制解除 · ko 강제 해제 · ru Принудительно снять
  - 依赖闸门的一次性知情放行;不译作「跳过」——它不跳过任何其它闸门
- **Delivery PR** — zh 交付 PR · ja 配信 PR · ko 전달 PR · ru PR поставки
  - 「交付分支 → 主线」的变更请求;与意图 PR(意图 → 交付分支)是不同实体,文案不得混用
- **Merge blocked** — zh 合并受阻 · ja マージがブロック · ko 병합 차단 · ru Слияние заблокировано
  - 交付 PR 开放但 CI 失败/审批不足;**代码没问题**,文案不得暗示要重做验证
- **Awaiting confirmation** — zh 等待确认 · ja 確認待ち · ko 확인 대기 · ru Ожидание подтверждения
  - forge 已合并、c3 尚未感知的窗口期;配「同步」动作,不得说成「同步中」
- **Custom reply** — zh 自定义回复 · ja カスタム返信 · ko 사용자 지정 답변 · ru Пользовательский ответ
  - 权限 AskUserQuestion 面板
- **Delivery event** — zh 交付事件 · ja デリバリーイベント · ko 딜리버리 이벤트 · ru Событие доставки
  - `delivery:*` 六类通用事件的统称;单条事件按动作译,见下行
- **Status changed** — zh 状态变更 · ja ステータス変更 · ko 상태 변경 · ru Статус изменён
  - `delivery:status_changed`;携带 from/to 两个交付状态,文案须用固定六态译法
- **Branch ready** — zh 分支就绪 · ja ブランチ準備完了 · ko 브랜치 준비 완료 · ru Ветка готова
  - `delivery:branch_ready`;与 branchReady 字段同义,不译作「分支创建」(绑定已有分支也算就绪)
- **Merge target** — zh 合并目标 · ja マージ先 · ko 병합 대상 · ru Цель слияния
  - `pr:merge` 的 `ref.baseBranch`/`baseTarget`;指这条 PR 合进了哪条分支
- **Mainline** — zh 主线 · ja メインライン · ko 메인라인 · ru Основная ветка
  - `baseTarget: 'mainline'`;工作区主分支,与「交付分支」成对区分产出落点
- **Delivery branch** — zh 交付分支 · ja デリバリーブランチ · ko 딜리버리 브랜치 · ru Ветка доставки
  - `baseTarget: 'delivery-branch'`;一条交付的集成分支,不译作「发布分支」

### Delivery 状态中文译法(固定,禁与意图状态词面混淆)

Delivery 六态中文固定为:待集成 / 集成中 / 验证中 / 验证通过 / 已发布 / 已取消。
交付没有「已完成」态 —— 它等于「所有关联意图的 PR 已合入交付分支」这一可推导事实,
只以「集成就绪 N/M」呈现,故:

> **禁用词(zh)**:delivery 状态与页面文案**不得使用「已完成」「进行中」**描述交付
> 的集成/验证进程(避免与意图 `done`/`in_progress` 词面混淆)。合法近义表达:
> 「已发布」(delivered)、「集成中/验证中」(过程态)、「验证通过」(verified)。

### Delivery 推进按钮文案(动作,不是状态名)

按钮说「按下去会发生什么」,状态名说「现在在哪」。两者共用一套词就会把「验证中」读成
当前状态而非可执行动作,故按边固定为动作用语,与上面的六态译法分属两套文案键:

| 边 (from→to)          | zh       | en                   | ja         | ko        | ru                   |
| --------------------- | -------- | -------------------- | ---------- | --------- | -------------------- |
| planned→integrating   | 开始集成 | Start integration    | 統合を開始 | 통합 시작 | Начать интеграцию    |
| integrating→verifying | 开始验证 | Start verification   | 検証を開始 | 검증 시작 | Начать проверку      |
| verifying→verified    | 确认验证 | Confirm verification | 検証を確認 | 검증 확인 | Подтвердить проверку |
| verifying→integrating | 返工     | Rework               | やり直し   | 재작업    | Переделать           |

### 闸门文案的措辞约束

依赖闸门的阻塞文案必须说清**哪一态**,否则用户无从下手:同交付说「依赖「X」在交付
「Y」中的 PR 未合入」,跨交付说「依赖「X」在交付「Y」,该交付未合入主线」并给出跳转,
无交付沿用原有「尚未合并到主分支」。

> **禁用表述(zh)**:强制放行不得写成「跳过依赖」或「忽略依赖」—— 它只跳过依赖这一道
> 闸门,且留有审计;写成「跳过」会让人以为其余闸门也一并绕过。worktree 基线不符的
> 文案不得暗示 c3 会代为重建或合并,也不得写成阻塞或失败 —— 它只陈述事实并列出**用户**可做什么。

## 2. 禁译表(保持原文,不翻译)

以下为产品名 / 协议名 / 技术专名 / 工具标识 —— **任何 locale 均保持英文原文**,
不音译、不意译。硬编码禁令豁免:这些词若以翻译 value 形式存在,value 各语种相同。

- **Claude Code**(产品名): Anthropic 产品名,整体不译
- **Claude**(产品名):
- **c3 / Code Creative Center**(产品名): 本应用名
- **MCP**(协议名): Model Context Protocol,缩写不译
- **Hook**(技术专名): Claude Code 钩子机制,不译
- **AskUserQuestion**(工具标识): 工具名,各 locale 保持原文,不译
- **Base URL / API**(技术专名): 配置字段名 / 接口缩写,各 locale 保持原文
- **工具名 / 标识符**(工具标识): `Write`/`Edit`/`Bash`/`mcp__c3__*` 等工具调用标识,各 locale 保持原文

## 3. 校验约定

- 翻译评审时逐条核对术语表;命中禁译表的词在 value 中保持原文。
- 插值占位符 `{name}`/`{count}` 与复数分支由一致性校验闸守护(见 i18n-spec §5.1),
  译文不得改写/增删占位符。
- 新增固定术语:**先在本清单登记,再落译文**。
