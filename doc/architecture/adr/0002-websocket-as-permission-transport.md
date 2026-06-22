# 0002 — WebSocket as the permission transport

- **Status:** accepted
- **Date:** 2026-05-29

## Context

A permission decision is inherently bidirectional and blocking: the server must push a
request to the browser at an arbitrary moment (mid-run, whenever the agent reaches a
sensitive tool) and then wait for the browser's answer before the SDK can proceed. The
agent also streams assistant text and tool activity continuously. The transport must carry
server-initiated pushes, not just request/response.

## Options considered

- **HTTP polling / long-poll.** Pros: simple, stateless. Cons: server can't cleanly push a
  blocking prompt; latency and complexity for streaming; awkward for the
  block-until-answered pattern.
- **Server-Sent Events + HTTP POST for answers.** Pros: native server push downstream.
  Cons: two channels to keep in sync; no single ordered stream; more moving parts.
- **A single WebSocket at `/ws`.** Pros: one ordered, bidirectional channel for prompts,
  streamed activity, permission requests, decisions, and mode changes; naturally models the
  block-and-resume flow via a request-id correlation. Cons: connection lifecycle and
  reconnect must be handled.

## Decision

Use one WebSocket at `/ws`. All traffic is JSON envelopes typed by the client-to-server and
server-to-client message unions defined once as the wire contract. A permission request
carries a correlation id; the browser's `permission_response` echoes it to correlate.

## Consequences

- **Easier:** a single ordered stream; the gateway can await a resolution keyed by the
  correlation id and complete it when the matching response arrives.
- **Harder:** the connection is session state. The client mitigates drops with a heartbeat +
  exponential-backoff auto-reconnect that re-selects the active session on reopen (AVAIL-6);
  background runs survive the drop regardless (AVAIL-3).
- The dev server proxies `/ws` to the backend so the browser connects transparently.

## Compliance

- The protocol is defined once as the shared wire contract and imported by both ends.
- Wire shapes are validated at the edge; unparseable messages are ignored, never approved.

## References

- `doc/shared/api-conventions/websocket-protocol.md`
- `doc/domains/core/permission-gateway/permission-gateway-spec.md`
