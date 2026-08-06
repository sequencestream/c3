# intents PR 事实核查（M1 拆表前置）

> 阻塞 M1（单条意图 `pr_id/pr_url/pr_status` 拆为多 PR 关系）的研究门禁。结论全部来自
> 本次证据，未预先沿用 M1 提议的字段类型或唯一键。PR 读点基线见
> [../intent/pr-readpoints.md](../intent/pr-readpoints.md)。
>
> 采样范围：`~/.c3/c3.db` 的 `intents` 表全量 849 行（2026-08-06 06:37 UTC 快照）。
> 工具：`sqlite3`（macOS 自带）、`gh` 2.96.0、`git` 2.50.1。glab 1.102.0 已安装但
> gitlab.com 未认证（401），GitLab 侧结论仅来自代码路径与单元测试，无线上样本。
> 敏感值：不写入完整私有 URL / token / 凭据；repo 名与 number 以聚合形式出现。

---

## 1. 时间列格式对照表（F1）

三列均以 SQLite `INTEGER` 声明，DDL 注释标明 epoch-ms。写入代码一律 `Date.now()`。
存量形态用「实际存储长度」区分 13 位 epoch-ms / 10 位 epoch-秒 / NULL：

| 列             | 业务含义     | SQLite 声明        | 实际存量形态（849 行）                                            | 写入来源                                                                           |
| -------------- | ------------ | ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `created_at`   | 创建时间     | `INTEGER NOT NULL` | 849/849 为 13 位整数（epoch-ms）                                  | `insertIntents`/`upsertIntents` 批量写入 `now + i`（同批内按序错开）；无 10 位样本 |
| `updated_at`   | 最后更新时间 | `INTEGER NOT NULL` | 839/849 为 13 位整数；**10/849 为 10 位整数（epoch-秒）**         | 所有受控写边界均 `Date.now()`（ms）；10 位异常行无法由当前代码产生，见下           |
| `completed_at` | 完成时间     | `INTEGER`（可空）  | 790/849 为 13 位；**10/849 为 10 位（epoch-秒）**；49/849 为 NULL | `updateStatus()` 在 `status='done'` 时打 `Date.now()`、离开 `done` 清 NULL         |

### 10 位 epoch-秒异常行

全部 10 行满足：`created_at` 连续递增（⋯863/⋯864/⋯/⋯877，同一基准秒）、`status='done'`、
`workspace_path` 均为 `sequencestream/video-stream`、`updated_at` 与 `completed_at`
等值且为 10 位 epoch-秒（解码为 2026-08-05 07:56–2026-08-06 00:39 区间）。这些行由
video-stream 工作区的**外部批量导入**写入（仓库内所有写路径均 `Date.now()`，不可能产生
10 位值）。对 M1 回填的含义：拆表/回填 SQL 必须对这类行做归一化（×1000 或在迁移中明确
排除/标注为遗留异常），否则目标模型的时间戳读取端会把 epoch-秒误当毫秒。

### 结论（M1 目标模型时间戳编码）

M1 的 `intent_prs` 目标时间戳应沿用既有约定：**`INTEGER` epoch-ms**（列名 `_at` 后缀）。
不引入 ISO-8601 TEXT。回填时对 10 位异常行归一化到 epoch-ms。

### 用户手填日期：全库零命中

`rg` 对 `start_date`/`end_date`/`startDate`/`endDate` 在 server/shared/web/database/
doc/scripts 全库严格搜索为 **0 命中**。当前 intents 模型与 M1 的 `intent_prs` 目标模型
均无此类字段。结论记为「**不存在、无格式可核查、非 M1 设计字段**」，不为它们虚构
SQLite 类型 / 写入来源 / 目标格式。未来若引入用户手填日期，须由对应设计意图另行定义。

---

## 2. `pr_id` 语义判定（F2）

三方证据交叉：

| 证据源                              | 证据                                                                                                                                                                                             | 结论                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| CLI 输出解析（`server/src/git.ts`） | `createGhPr()` 解析 `gh pr create` 输出 `https://github.com/owner/repo/pull/(\d+)$` 取捕获组为 `prId`；`createGlabMr()` 解析 `glab mr create` 输出 `/-\/merge_requests\/(\d+)` 取捕获组为 `prId` | 两端 CLI 都提取**仓库内数字 number** |
| 写入边界（`setPrInfo`）             | `store.ts:1179` 把 `prId` 原样写入 `pr_id` 列；三条创建路径（`write-cores.ts`/`dev-cleanup.ts`/`queue-dev-actions.ts`）都只传 CLI 解析出的 number                                                | 落库值 = CLI 提取的 number           |
| 存量行（849 行全量）                | 365 个非空 `pr_id` 全部为**纯 ASCII 数字**（1–3 位：长度 1×34、长度 2×157、长度 3×174）；341 行带 `pr_url`，其尾部 `/pull/<N>` 与 `pr_id` 一一对应                                               | 存量即仓库内 number                  |

**判定：`pr_id` = 仓库（project）内 PR/MR number。** GitHub 与 GitLab 的 CLI 解析路径
提取的是同一语义（git.test.ts:293-378 亦验证两端期望值）。当前全部线上样本为 GitHub；
GitLab 结论来自代码 + 单元测试（glab 本机未认证，无线上样本，见局限）。

**边界与例外：** `createGhPr` 有「URL 正则不匹配时回退用整条 URL 当 `prId`」的兜底
（git.ts:688-690），但存量 365 行无一行属于该形态，可忽略；M1 迁移后该兜底路径应一并
废弃。

### 唯一键结论

`pr_id` 已证实为仓库内 number ⇒ 候选键 **`UNIQUE(forge, repo, number)` 成立**，其中
`number` 即当前 `pr_id` 的值。

> 若未来出现非 number 语义（例如改为 forge node/global id），按既定裁决应改判为
> **`UNIQUE(forge, repo, forge_pr_id)`**：`forge_pr_id` 原样保存已证实的 forge 标识，
> `number` 由 API/URL 独立取得且不得冒充唯一键。当前证据充足，无需该改判。

**注意事项：** `forge` 与 `repo` 目前**不落库**——`detectForge` 按 workspace git origin
实时判定（git.ts:637-640），`repo` 从 `pr_url` 或 origin 解析。M1 建 `intent_prs` 表时
必须把 `forge`+`repo` 显式持久化，唯一键才有意义；只存 number 不存 repo 会回到当前
「跨仓库无法区分」的状态。

### 附带发现：`pr_status` 取值域

DDL 注释（intents.sql:22）写 `'reviewing'|'rejected'|'failed'|'merged'`，但运行时类型
（shared/src/protocol/intent.ts:100）为 `'reviewing'|'rejected'|'failed'|'merged'|'closed'`
——**DDL 注释缺 `'closed'`**。存量 382 行非空 `pr_status`：merged 378 / reviewing 3 /
closed 1。M1 拆表时应以共享协议类型为准并修正 DDL 注释。

---

## 3. 存量 base 断言（F3）

**方法：** 对 849 行中 365 个非空 `pr_id`，逐一解析 forge/repo 后以 `gh pr view <n>
--repo <owner/repo> --json baseRefName,headRefName,state,mergedAt` 查询真实 PR。

- **样本总数**：365（非空 `pr_id` 全量）。
- **repo 解析**：341 行经 `pr_url` 提取 `owner/repo`；24 行仅有 `pr_id`（无 `pr_url`），
  经 workspace git remote 解析——其中 17 行 `sequencestream/c3`、7 行目录已删除的
  `sequencestream/claude-code-center`。
- **canonical repo 归一**：`sequencestream/code-creative-center` 与
  `sequencestream/claude-code-center` 均为 `sequencestream/c3` 的改名重定向
  （`gh repo view` 验证），归一并库。最终 repo 分布：c3×260 / tiltwind-yoni×64 /
  sequencestream-video-stream×16 / vogo-aimodel×15 / vogo-vv×5 / vogo-vage×5。
- **可核查数**：**365/365**（全部解析成功，`gh` 返回真实 PR）。13 次首轮查询遇
  GitHub GraphQL 瞬时 `unexpected EOF`，重试后全部成功，无「无法核查」项。
- **各 base 计数**：**`main` × 365，非 `main` × 0**。head 均为 `intent/<slug>` 形态。
- **真实性交叉**：真实 forge state = merged 363 / closed 1 / open 1。

**结论：存量 base 全为字面 `main`（可核查数 = 样本总数 = 365，且全部 main），断言成立。**

**运行时佐证：** 三条 PR 创建路径（`write-cores.ts:163`、`dev-cleanup.ts:199-206`、
`queue-dev-actions.ts:435-442`）传给 `createForgePr`/`createGhPr` 的 `baseBranch` 均为
`undefined`，而 `createGhPr`/`createGlabMr` 的默认值是 `'main'`（git.ts:660,706）——
系统从未以非 main 为 base 建过 PR。

**数据质量观察（非 F3 结论）：** DB `pr_status` 与 forge 真实状态存在漂移（378 行标
merged，真实 merged 仅 363；2 行标 reviewing 实为 merged）；另有 17 行 `pr_status='merged'`
但无 `pr_id`。这类行在 M1 回填时需单独处理（无法按 `pr_id` 关联 PR）。

---

## 4. 可复验命令

F3 审计（一次性，结果已固化于本节统计）：

```bash
# 枚举 (repo, number)：URL 行
sqlite3 -readonly ~/.c3/c3.db "SELECT pr_url FROM intents WHERE pr_url IS NOT NULL AND pr_url!='';" \
  | sed -E 's#https://github.com/([^/]+)/([^/]+)/pull/([0-9]+)#\1/\2\t\3#'
# 无 URL 行：workspace git remote 解析 + 查真实 PR
gh pr view <n> --repo <owner/repo> --json baseRefName,headRefName,state,mergedAt
```

多 base 行为实验（可重跑，见 `scripts/verify-multi-base-pr.mjs`）：

```bash
node scripts/verify-multi-base-pr.mjs \
  --github-repo tiltwind/c3-multibase-verify \
  --head c3-mb/head --base-a main --base-b develop \
  --out /tmp/mb-gh.json          # 创建/复用并复核
node scripts/verify-multi-base-pr.mjs ... --cleanup   # 显式关闭本脚本标记 PR
```

实验环境与结论（2026-08-06，gh 2.96.0，一次性私有测试仓库 `tiltwind/c3-multibase-verify`）：
首跑创建 base=main 与 base=develop 两个开放 PR 并 PASS；二跑复用既有 PR（不新增重复）
仍 PASS；`--cleanup` 关闭后重跑自动新建并 PASS。**GitHub：同 head 对两个不同 base 可
同时保持开放 PR（PASS）。** GitLab：本机 glab 未认证，按 spec 规则 SKIP——**不得据此
宣称两端均支持**；GitLab 结论留待认证后在同一脚本下补验。

---

## 5. 对 M1 的阻塞影响与缺口

- 唯一键：`UNIQUE(forge, repo, number)` 成立；`forge`/`repo` 必须在 M1 建表时显式落库。
- 时间戳：目标模型沿用 epoch-ms INTEGER；回填需归一化 10 行 epoch-秒异常值。
- 存量 base 全为 main 已证实 ⇒ M1 对存量回填可安全假定 base=main；但新能力引入非 main
  base 后回填假定即失效，须以 `intent_prs` 每行独立记录 base。
- 未证实缺口：GitLab 线上样本（glab 未认证）与 `pr_status` 漂移的 17 无-id 行的回填
  归属。这两项不影响拆表本身，但在回填 SQL 前需另行处置。
