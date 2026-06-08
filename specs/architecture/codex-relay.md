# Codex Responses→Chat Relay 架构

- **Status:** draft
- **Date:** 2026-06-08
- **References:** ADR-0014 (`adr/0014-codex-in-process-responses-chat-relay.md`), `transport/codex-relay/`, `adapters/codex/driver.ts`
- **挂载点:** `server/src/transport/codex-relay/index.ts` + `server.ts:455-457`

## 1. 为什么需要这个 relay

Codex 0.137+ 在 **线缆协议层面只能讲 OpenAI Responses API**（`POST /v1/responses`，默认 websocket 优先）。主流第三方提供商（DeepSeek、Kimi、MiMo、MiniMax、硅基流动等）只实现了 Chat Completions API（`POST /v1/chat/completions`），没有 `/responses` 端点。用户配置一个 `custom` codex agent 指向这类提供商时，codex 子进程直接请求 `https://api.deepseek.com/responses` 得到 404。

c3 用 **in-process relay** 填补这个鸿沟：在 c3 自身 Hono 服务器上挂载一个 loopback 端点，codex CLI 被配置为把 API 流量发到这个端点，relay 在两端之间做双向协议翻译。用户不需要安装任何外部代理（LiteLLM / codex-relay 等），c3 单二进制即可处理。

**关键约束：**

- 第一方 OpenAI 不走 relay（`configMode: system`，codex 自己的 openai provider 直接对话 OpenAI Responses API）。
- 只有 `custom` codex agent（用户配置了第三方 baseUrl）才走 relay。
- relay 只服务 Chat-Completions-only 提供商；如果某个提供商未来也支持 Responses API，可跳过 relay。

## 2. 核心实现方案

### 2.1 整体架构

```
┌───────────────────────────────────────────────────────────────────┐
│  c3 server process                                                │
│                                                                   │
│  ┌─────────────────────┐     POST /internal/codex-relay/v1/       │
│  │  codex CLI (0.137+) │ ──── /responses ──────────────────────────► │
│  │  (子进程)           │ ◄──── SSE (Responses 事件) ──────────────── │
│  │  CODEX_API_KEY=token │                                          │
│  └──────────┬──────────┘                                          │
│             │                                                      │
│             │  Authorization: Bearer <token>                       │
│             ▼                                                      │
│  ┌──────────────────────────────────────────────┐                 │
│  │  CodexRelay (transport/codex-relay/)          │                │
│  │                                               │                │
│  │  ┌──────────┐    ┌──────────────────────┐    │                │
│  │  │ Token    │───►│ responsesRequestToChat │    │               │
│  │  │ Registry │    │ (Responses→Chat)       │    │               │
│  │  └──────────┘    └──────────┬───────────┘    │                │
│  │                              │                │                │
│  │                              ▼                │                │
│  │                    ┌──────────────────────┐   │                │
│  │                    │ fetch() 到上游        │   │                │
│  │                    │ /v1/chat/completions  │   │                │
│  │                    └──────────┬───────────┘   │                │
│  │                              │                │                │
│  │                              ▼                │                │
│  │  ┌──────────────────────┐    │                │                │
│  │  │ ChatToResponsesConverter│ ◄── Chat SSE 流  │               │
│  │  │ (Chat→Responses)     │                      │               │
│  │  └──────────────────────┘                      │               │
│  └──────────────────────────────────────────────┘                 │
│                                                                   │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  Driver (adapters/codex/driver.ts)                   │       │
│  │  - register(upstream) → token                         │       │
│  │  - 配置 codex CLI: custom model_provider               │       │
│  │  - NO_PROXY += loopback hosts                         │       │
│  └──────────────────────────────────────────────────────┘        │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 双向翻译核心

两个纯函数模块，无 SDK 依赖，无 HTTP 面（ADR-0009 R2 合规）：

#### 方向 A：Responses 请求 → Chat Completions 请求（`translate.ts:responsesRequestToChat`）

| Responses 字段                                                   | Chat Completions 字段                       | 处理方式                                          |
| ---------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| `instructions`                                                   | `messages[0]` (role: system)                | 前置为 system 消息                                |
| `input[].type=message` (role: developer)                         | `messages[N]` (role: system)                | developer 角色折叠为 system                       |
| `input[].type=message` (role: user)                              | `messages[N]` (role: user)                  | 直接映射                                          |
| `input[].type=function_call`                                     | `messages[N]` (role: assistant, tool_calls) | 多个相邻 function_call 合并为一个 assistant 消息  |
| `input[].type=function_call_output`                              | `messages[N]` (role: tool)                  | 转为 tool 消息                                    |
| `tools[].type=namespace`                                         | 展开为子 tools                              | 扁平化 namespace 为独立 function tool             |
| `tools[].type=function`                                          | `tools[N].type=function`                    | 直接映射，保留 name/description/parameters/strict |
| `stream=true`                                                    | 固定为 true                                 | 强制启用                                          |
| store / include / reasoning / prompt_cache_key / client_metadata | 丢弃                                        | Responses 专用字段，Chat 无对应                   |
| `tool_choice` 对象值（如 `{type:"function",name:"xxx"}`）        | 降级为 `"auto"`                             | Chat 格式不同，安全降级                           |

#### 方向 B：Chat Completions SSE 流 → Responses SSE 事件（`translate.ts:ChatToResponsesConverter`）

将 Chat 流实时转换为 codex 的 SSE 事件流。映射策略：

| Chat SSE chunk 字段                     | Responses SSE 事件                                                       | 说明                                                            |
| --------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `delta.content`                         | `response.output_text.delta`                                             | 实时流式输出，同时跟踪累积 text                                 |
| `delta.reasoning_content`               | `response.reasoning_text.delta`                                          | 仅当上游支持 reasoning 时产生（如 DeepSeek-R1）                 |
| `delta.tool_calls[].function.arguments` | `response.function_call_arguments.delta`                                 | 累积 arguments 直到完成                                         |
| 流结束（`[DONE]` 或 finish_reason）     | `response.output_item.done`（assistant message + 每个 tool call 各一个） | 在 done() 里一次生成全量 output items                           |
| 流结束                                  | `response.completed`（必需，含 id + usage）                              | 缺少此事件 codex 报错 "stream closed before response.completed" |
| 上游异常                                | `response.failed`                                                        | codex 映射为可重试错误                                          |

> codex 的 Rust SSE 解析器（`codex-rs/codex-api/src/sse/responses.rs`）以 JSON `type` 字段键控事件、**忽略未知事件类型**——这为兼容性提供了缓冲：Relay 可以 emit 旧版解析器不理解的字段，不会被拒绝。

### 2.3 安全绑定：token registry

```
driver.register({baseUrl: "https://api.deepseek.com", apiKey: "sk-xxx"})
  → 返回 UUID token "550e8400-..."
  → 将 token 设为 CODEX_API_KEY（codex CLI 作为 Authorization: Bearer <token> 发送）
  → relay handler 根据 token 查找真实 apiKey，发起上游请求
  → run 结束后 driver.unregister(token) 清理绑定
```

防御层次：

1. **loopback 绑定** — relay 只监听 `127.0.0.1`，外部不可达。
2. **token 验证** — 未知 token 返回 401 JSON，拒绝处理。
3. **token 一次性** — run 结束即注销，不存在长期凭证。
4. **真实 key 不离开 c3** — codex 子进程只看到 UUID token，永远不接触上游 apiKey。

### 2.4 codex CLI 配置（driver 端的拼接）

relay 路径下，codex CLI 以如下配置启动：

```bash
codex exec \
  --model deepseek-chat \
  -c model_provider="c3relay" \
  -c model_providers.c3relay.name="c3relay" \
  -c model_providers.c3relay.base_url="http://127.0.0.1:<c3port>/internal/codex-relay/v1" \
  -c model_providers.c3relay.env_key="CODEX_API_KEY" \
  -c model_providers.c3relay.wire_api="responses" \
  -c model_providers.c3relay.supports_websockets=false
# CODEX_API_KEY=<token>  # token 作为 apiKey
# NO_PROXY=127.0.0.1,localhost,::1  # 防止 loopback 被 HTTP_PROXY 劫持
```

`supports_websockets=false` 是关键：告诉 codex 不要尝试建立 websocket 连接，fallback 到普通 HTTP POST + SSE，这是 relay 唯一支持的模式。

### 2.5 挂载点（composition root）

`server/src/server.ts` 在创建 Hono app 后、static catch-all 之前注册 relay 路由：

```typescript
const codexRelay = createCodexRelay(`http://127.0.0.1:${port}`)
app.post(`${CODEX_RELAY_PATH}/responses`, (c) => codexRelay.handler(c))
// CODEX_RELAY_PATH = '/internal/codex-relay/v1'
```

在 `compositionRoot` 中传递给 codex adapter factory 的是 `codexRelay` 的 kernel 面（`baseUrl` + `register`/`unregister`），不是 HTTP handler。遵循 ADR-0009 R2（kernel 不碰 HTTP）。

## 3. 兼容性保障

### 3.1 API 面映射是双向的有限子集

Relay 翻译的不是整个 Responses API，而是 codex 0.137+ 实际发送的结构化子集。Codex CLI 作为客户端只使用了 Responses API 的一个固定子集：

- **请求面:** `instructions` + `input[]`（message / function_call / function_call_output）+ `tools[]`（function / namespace）+ `tool_choice` + `parallel_tool_calls` + `stream`。
- **响应面:** `response.created` / `response.output_text.delta` / `response.output_item.added` / `response.output_item.done` / `response.function_call_arguments.delta` / `response.reasoning_text.delta` / `response.completed` / `response.failed`。

不在这个子集中的 Responses 特性（`include` / `store` / `reasoning` / `metadata` / `instruction_like` / `file` / `web_search`（TODO）等）在 translate 中直接丢弃或走默认值，codex 不使用它们。

### 3.2 测试保障

| 测试层级     | 位置                | 覆盖内容                                                                                                                                    |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元测试     | `translate.test.ts` | 真实捕获的 codex 请求 fixtures → Chat 请求；所有 Chat→Responses 事件类型（text / tool / reasoning / parallel tool / usage / error / empty） |
| 注册单元测试 | `index.test.ts`     | Token 生命周期、URL 规整、未知 token 拒绝                                                                                                   |
| 端到端测试   | `e2e.codex.test.ts` | 真实 codex 二进制 + real Hono relay + fake Chat upstream；验证 codex 识别翻译后的 Responses SSE                                             |

E2E 测试在 `codex` CLI 未安装时自动跳过（`.codex.` 文件名约定 + host-binary guard）。

### 3.3 反向兼容契约

任何上游 API 变更要破坏 relay，需要以下之一成立：

1. **codex CLI 升级后改变了它发送的 Responses 请求结构**（新增必填字段 / 改变现有字段语义 / 移除字段）。
2. **codex CLI 升级后改变了它解析的 Responses SSE 事件结构**（`response.completed` 不再必需 / 事件 type 值变更 / 新增必读字段）。
3. **主流 Chat-Completions 提供商变更了 Chat SSE 格式**（delta 结构非向后兼容的变更）。
4. **Codex CLI 自身升级后移除了 `supports_websockets` 或 `wire_api` 配置项**（阻止 relay 配置生效）。
5. **OpenAI 发布了新版本的 Responses API**（v2 endpoints、协议格式变更）。

## 4. API 变更监控

### 4.1 周期性检测任务

配置一个**定时任务**（通过 c3 的 `schedules` 能力或外部 CI cron），每 **14 天** 执行一次以下检测：

```yaml
schedule: '0 9 */14 * *' # 每 14 天早上 9 点
action: monitor-openai-api-changes
target: codex-responses-chat-relay
checks:
  - id: codex-release
    name: 'Codex CLI 新版发布'
    source: 'https://github.com/openai/codex/releases'
    method: check-latest-tag # 对比本地记录的 last_checked_tag
  - id: codex-responses-schema
    name: 'Codex Responses API 请求结构变更'
    method: grep-codex-rs-source # 在本地 codex 源码或 releases 的 SDK 类型定义中搜索
    patterns:
      - 'responses.rs'
      - 'responses.proto'
      - 'ThreadEvent'
      - 'item.started|item.updated|item.completed'
  - id: openai-responses-api
    name: 'OpenAI Responses API 官方变更'
    source: 'https://platform.openai.com/docs/api-reference/responses'
    method: check-docs-changelog
  - id: codex-sdk
    name: '@openai/codex-sdk npm 版本变更'
    source: 'https://www.npmjs.com/package/@openai/codex-sdk'
    method: check-npm-version # 对比 package.json 中记录的版本
```

**实现建议（第一阶段）：** 利用 c3 已有的 `schedules` 域名能力，注册一个周期性 schedule，其 handler 是 `monitorApiChanges`。该 handler 产出分析结果后自动创建一个 Intent（P2 或 P1，视变更严重程度），标题形如 `[API Monitor] Codex relay: <变更摘要>`。

**实现建议（第二阶段可选）：** 在 CI（GitHub Actions / GitLab CI）中增设一个每周 workflow，执行 `scripts/check-codex-upstream.mjs`，如果有 new release 则自动创建 GitHub Issue 或 PR。但第一优先级是在 c3 内部闭环。

### 4.2 手动触发

提供 `rtk` CLI 别名或 `pnpm` script 供手动触发：

```bash
pnpm check:codex-upstream
# 或
rtk proxy pnpm check:codex-upstream
```

输出格式：检测结果清单 + 变更等级评估 + 建议 action。

### 4.3 变更等级评估矩阵

| 变更类型                                       | 等级 | 评估标准                                                    | 建议响应                                                                    |
| ---------------------------------------------- | ---- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| Codex CLI 不再支持 `supports_websockets=false` | P0   | relay 无法迫使 codex 走 HTTP SSE                            | 立即停用 relay 路径并回退到直接连接（如果可能）；升级 codex-sdk 适配器      |
| Responses API 新增必填请求字段                 | P1   | codex 新版本发送了 relay 不理解的字段                       | 更新 `translate.ts:responsesRequestToChat`，添加新字段 map                  |
| Responses SSE 事件 type 值变更                 | P1   | codex 解析器不识别 relay 发出的旧事件 type                  | 更新 `ChatToResponsesConverter` 输出的事件 type                             |
| 上游 Chat 提供商改变了 delta 结构              | P1   | relay 的 SSE 解析器无法正确提取内容                         | 更新 `SseChunkParser` / `ChatToResponsesConverter.consume`                  |
| Codex CLI 新增了不兼容的 SSE 事件需求          | P1   | codex 要求 relay 发出它不理解的新事件                       | 在 `done()` 中添加新事件 type 的 stub 发射（利用 codex 忽略未知事件的特性） |
| 第三方 Chat 提供商新增标准 Chat 字段           | P2   | relay 可以忽略但建议支持以获取更好体验（如 usage 新子字段） | 更新 `mapUsage()` 以传递新字段                                              |
| Codex SDK npm 包次要/补丁版本升级              | P2   | 类型定义可能微调但协议不变                                  | 读取 CHANGELOG，若无 wire-protocol 变更则仅升级依赖                         |

### 4.4 变更新流程

当检测发现可疑变更时，按此流程处理：

```
检测触发
  │
  ▼
步骤 1: 收集变更证据
  ├── 读取 codex release notes / 比较 tag diff
  ├── 阅读 openai/codex-rs 源码中相关模块的 diff
  └── 抓取 openai docs 的 Responses API 页面
  │
  ▼
步骤 2: 分析影响面
  ├── 检查 changelog 中是否出现 "breaking" / "wire" / "responses" / "sse" 等关键词
  ├── 对比 `__fixtures__/responses-request.real.json` 是否仍匹配新版本请求
  └── 运行 `pnpm vitest run transport/codex-relay/` 看现有测试是否通过
  │
  ▼
步骤 3: 创建 Intent（仅当明确变更影响 relay）
  └── 在 c3 中创建一个 Intent:
        - 标题: `[codex-relay] <变更摘要>` （如 "[codex-relay] Codex 0.145 新增 required 字段 model_params"）
        - 内容: 变更位置 + 影响范围 + 修改建议
        - 优先级: 根据评估矩阵（P0/P1/P2）
        - 模块: system-config（relay 属于基础设施层）
  │
  ▼
步骤 4: 实施修改
  ├── 更新 `translate.ts` 中的映射逻辑
  ├── 更新测试断言和 fixtures（重新捕获 codex 新版本的请求体）
  ├── 更新本 spec 文档的协议映射表
  └── 运行 `pnpm typecheck && pnpm lint && pnpm vitest run` 全绿
  │
  ▼
步骤 5: 验证
  ├── 单元测试覆盖新字段映射
  └── 如有可用 codex 二进制，运行 e2e 测试确认实际流量正常
```

## 5. 代码映射关系

| 职责                       | 文件                                                             | 核心模块/函数                                           |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| 纯翻译（请求）             | `transport/codex-relay/translate.ts`                             | `responsesRequestToChat()`                              |
| 纯翻译（响应流）           | 同上                                                             | `ChatToResponsesConverter`                              |
| SSE 线协解析               | 同上                                                             | `SseChunkParser`                                        |
| SSE 序列化                 | 同上                                                             | `serializeSse()`                                        |
| HTTP 处理 + token registry | `transport/codex-relay/index.ts`                                 | `createCodexRelay()` → `handler`                        |
| 挂载                       | `server/server.ts:455-457`                                       | `app.post(...)`                                         |
| 驱动层集成                 | `adapters/codex/driver.ts`                                       | `CodexDriver.start()` relay 分支                        |
| Kernel 面 handle           | `adapters/codex/relay-contract.ts`                               | `CodexRelay` / `RelayUpstream` / `CODEX_RELAY_PROVIDER` |
| E2E 测试                   | `transport/codex-relay/e2e.codex.test.ts`                        | `runCodex()` with real binary                           |
| 单元测试                   | `transport/codex-relay/{translate,index}.test.ts`                | 翻译 + registry                                         |
| 请求 fixtures              | `transport/codex-relay/__fixtures__/responses-request.real.json` | 真实捕获的 codex 0.137.0 POST body                      |

## 6. 已知限制

1. **Node.js fetch 不识别 HTTP_PROXY** — relay 向公共提供商出站是直连的。对于有强制代理出口的环境，此处不处理。
2. **非流式降级** — `stream` 强制为 true，非流式 Chat 请求不生成。
3. **工具选择的降级** — `tool_choice` 的对象值（如 `{type:"function",name:"xxx"}`）降级为 `"auto"`，因为 Chat API 的 tool_choice 结构不同。
4. **无多模态支持（当前）** — `input_image` 类型被映射为 Chat 的 `image_url`（可工作），但 codex 的 `file` 输入类型没有 Chat 对应项。
5. **Token usage 忠实映射** — Chat usage 转为 Responses 格式，非 OpenAI 提供商可能返回自定义 usage 字段，当前 `mapUsage` 只处理标准字段，额外字段丢失。
6. **Reasoning tokens 依赖上游** — 只有支持 `reasoning_content` 的上游（DeepSeek-R 系列）才产生 `reasoning_text.delta`；其他提供商无副作用。
7. **无缓存** — 每次请求都经过翻译，不存在映射缓存。loopback 延迟可忽略不计。
