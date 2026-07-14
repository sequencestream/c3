# ADR-0027: `<category>:<action>` 事件命名 + 多行订阅 + 级联表单

**状态**: 实施中 (2026-07-14)
**关联**: [ADR-0018](0018-event-bus-kernel-layer.md)、[ADR-0026](0026-generic-event-normalizer-registry.md)

## 上下文

先前的通用事件契约 `GenericEvent = { type, status, metadata, data }` 在实践中出现命名不一致：
`run:started/run:settled` 是 `大类:动作` 形态，但 `pr:operation` 把动作隐藏在 `metadata.operation`,
`intent:lifecycle` 把动作冒充 `status`（phase）。这导致 Automation UI 无法做统一的级联选择，
新事件类型的可发现性差。

## 决策

1. **命名规范**: 事件 `type` 统一为 `<category>:<action>`（大类:动作），两段小写冒号分隔。
   动作 = 已发生的领域事实；status = 该事实的结果状态；metadata = 其余扁平上下文。

2. **具体映射**:
   - `run:started` / `run:settled` 保留（已符合规范）；
   - `pr:operation` 拆为 `pr:create|review|merge|close|comment|update`，status 为 `success|failure|error`；
   - `intent:lifecycle` 拆为 `intent:created|dev_started|done|failed|cancelled`，无 status 维度。

3. **过渡别名**: `pr:operation` 归一化器保留，收到旧格式时自动改写为新 type 输出（一个版本后移除）。

4. **多行订阅**: `Automation.eventFilter: GenericEventFilter | null` → `eventFilters: GenericEventFilter[] | null`
   （数组 OR 语义），对应 DB 新增 `event_filters` 列。

5. **大类通配**: filter type 可用 `<category>:*`（如 `pr:*`）匹配该大类所有动作。

6. **sessionKind/runKind 同构化**: run 桥投影时将这两个上下文写入 `event.metadata`，
   消除按 topic 的专属投影。

7. **级联表单**: 前端大类→动作→状态三级级联，每层保留「其他」自由输入。

## 理由

- 命名一致降低认知成本；三级级联直接暴露已知可订阅类型，提升可发现性。
- 保留自由字符串契约允许自定义类型不经改协议加入。
- 多行 OR + 大类通配`:*` 覆盖了现有 `intent:lifecycle` 多阶段订阅和
  `pr:operation` operation 多选的所有表达需求。
- 过渡别名保证在途会话不受影响。

## 影响

- **模式 (`shared/src/protocol.ts`)**: 新增 `EVENT_CATALOG`、`eventTypeMatches`、`upgradeV12EventFilter`。
- **服务端**: PR 归一化器注册 6 个 type + 别名；run/intent 桥投影改写。
- **数据库**: v13 新增 `event_filters` 列 + 幂等回填。
- **前端**: 级联表单替换旧 ChoiceInput；导入/导出兼容三种格式。
