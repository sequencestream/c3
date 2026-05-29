# Non-Functional — Performance

c3 is a single-user local tool; performance targets are about responsiveness and bounded
waiting, not throughput.

## Requirements

| ID     | Requirement                         | Target                                                                                                                                        |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| PERF-1 | Permission request → browser render | The `permission_request` is rendered as soon as it arrives over the local WebSocket; no artificial delay added by c3.                         |
| PERF-2 | Permission decision wait            | Each pending request resolves within **60 s**; on expiry it auto-denies (`PERMISSION_TIMEOUT_MS = 60_000`).                                   |
| PERF-3 | Streaming latency                   | Assistant text and tool activity are forwarded to the browser as each SDK message is received; c3 buffers no more than one message at a time. |
| PERF-4 | Run abort                           | A new `user_prompt` aborts the in-flight run before the next run starts; the abort is issued synchronously on message receipt.                |
| PERF-5 | Concurrency                         | At most **one** agent run is in flight per connection at any time.                                                                            |

## Notes

- End-to-end latency is dominated by the model and the `claude` process, which c3 does not
  control. These targets cover only c3's own added overhead.
- The 60 s timeout is the single tunable latency bound and lives in
  `server/src/permissions.ts`.
