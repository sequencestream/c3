# Non-Functional — Availability

c3 is a local foreground process. There is no clustering, no failover, no SLA. Availability
requirements are about clean degradation and not leaving the user stuck.

## Requirements

| ID      | Requirement                                                                                                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AVAIL-1 | If the `claude` executable cannot be found or the SDK errors, the run ends with a `session_end` of `reason: 'error'` carrying the message — never a silent hang.                                                                                                                    |
| AVAIL-2 | A permission request blocks indefinitely until the user answers — by design, mirroring the CLI prompt (no timeout). It is released only by a user decision or by the run being aborted (WS close / session switch / new prompt; see AVAIL-3, AVAIL-4), which resolves it as `deny`. |
| AVAIL-3 | Closing the WebSocket aborts the in-flight run and releases per-connection state; the server stays up for new connections.                                                                                                                                                          |
| AVAIL-4 | A new prompt while a run is in flight aborts the old run cleanly; `interrupt()` rejections (e.g. "not ready for writing") are swallowed and do not crash the process.                                                                                                               |
| AVAIL-5 | An unparseable client message is ignored without tearing down the connection.                                                                                                                                                                                                       |

## Known gaps (documented, not yet addressed)

- **No client auto-reconnect.** On socket close the browser reports `closed` and does not
  reconnect automatically; the user reloads the page. Tracked as a future improvement.
- **No run-resume across reconnect.** Because state is in-memory per connection, a dropped
  connection loses the in-flight run.
