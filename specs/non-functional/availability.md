# Non-Functional — Availability

c3 is a local foreground process. There is no clustering, no failover, no SLA. Availability
requirements are about clean degradation and not leaving the user stuck.

## Requirements

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AVAIL-1 | If the `claude` executable cannot be found or the SDK errors, the turn ends with a `turn_end` of `reason: 'error'` carrying the message — never a silent hang.                                                                                                                                                                                    |
| AVAIL-2 | A permission request blocks indefinitely until the user answers — by design, mirroring the CLI prompt (no timeout). It is released only by a user decision or by the run being stopped (`stop_run` / delete / workspace removal; see AVAIL-4), which resolves it as `deny`. Switching the viewed session or closing the socket never releases it. |
| AVAIL-3 | Closing the WebSocket only unsubscribes that connection's view; in-flight runs continue in the background and the server stays up for new connections. Reconnecting and selecting the session replays the full record (ADR 0006).                                                                                                                 |
| AVAIL-4 | Stopping a run (`stop_run` / delete / workspace removal) interrupts it cleanly; `interrupt()` rejections (e.g. "not ready for writing") are swallowed and do not crash the process. A second prompt for a session whose turn is in flight is rejected, not coalesced.                                                                             |
| AVAIL-5 | An unparseable client message is ignored without tearing down the connection.                                                                                                                                                                                                                                                                     |

## Known gaps (documented, not yet addressed)

- **No client auto-reconnect.** On socket close the browser reports `closed` and does not
  reconnect automatically; the user reloads the page. The background run is unaffected and is
  picked up again on reselect. Tracked as a future improvement.
- **No runtime eviction.** Session runtimes (their event buffers) live for the process
  lifetime; there is no memory cap or eviction yet. Acceptable for a local single-user tool.
