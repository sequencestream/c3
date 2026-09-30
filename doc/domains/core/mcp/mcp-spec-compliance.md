# MCP 规范对齐

本文只谈协议层：传输、协商纪元、刻意不实现。公开入口的工具、授权、工作区钉定与本机暴露见
[external-mcp](../external-mcp/external-mcp-spec.md)。内部面用回环与一次性 per-run 令牌，与公开面并列、不是放宽。

## 传输

内部回环面与公开 `POST /mcp` 使用同一 Streamable HTTP。协议行为不按面分化。

## 协商

服务端讲 2025 纪元的有会话协议，`initialize` 应答 `2025-11-25`。不实现 `2026-07-28` 无会话修订。
遵守协商结果的客户端按 2025 纪元工作；无会话形态不在支持范围。

## 刻意不实现

工具结果以文本 JSON 表达，不做结构化输出协商。暴露、发现与 OAuth 等产品边界见
[external-mcp](../external-mcp/external-mcp-spec.md#接受的限制)。
