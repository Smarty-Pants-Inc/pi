# Native input admission (version 1)

A user input can be awaiting an extension handler without being in a steering or follow-up queue yet. An idle check alone used to miss that input: a host could replace the session, then receive success for input enqueued into the disposed session.

Version 1 accounts for that phase natively and refuses unsafe replacement. It does not replay or silently transfer input between sessions.

## Detect the running host

- SDK: `session.capabilities.inputAdmission === 1`.
- Extensions: `pi.hostCapabilities.inputAdmission === 1`. Do not infer the running host's guarantee from an extension's separately installed package export.
- RPC: `get_state.data.capabilities.inputAdmission === 1`.
- `HOST_CAPABILITIES` is also exported for package-level detection.

`session.inputAdmissionCount` counts inputs awaiting native handoff. Admission starts synchronously at entry to `prompt()`, `steer()`, `followUp()`, and `sendUserMessage()`, before any asynchronous input handler, command lookup, image processing, auth or preflight. It ends on actual queue/run handoff, handled short-circuit, or failure. Commands own their input once their handler is dispatched, so commands can replace sessions without fencing themselves.

While admission is pending, `isIdle` is false, `isPromptPending` is true, and `pendingMessageCount` includes the admission. `getSteeringMessages()` and `getFollowUpMessages()` remain actual queue contents. A queued message can wait for a later prompt even when no run is active; check pending counts as well as idle. Extension `ctx.hasPendingMessages()` includes admissions. Settlement-deferred inputs remain accounted for until their native handoff; scheduling alone does not resolve their SDK result or acknowledge them. Extension `pi.sendUserMessage()` remains detached, so settlement handlers can schedule a turn without awaiting their own completion.

RPC state includes `inputAdmissionCount`, `inputsFenced`, `isIdle`, and `isPromptPending` alongside existing fields. Input responses are authoritative: success is emitted only after handling or native handoff; failed admission never gets a success response. `RpcClient.prompt()`, `steer()`, and `followUp()` reject failed responses.

## Fence replacement

```typescript
const release = await session.fenceInputs();
try {
  // Input is already closed, including across asynchronous host lifecycle work.
} finally {
  release();
}
```

`fenceInputs()` closes admission synchronously, before its returned promise can yield. It refuses immediately with `InputAdmissionError.code === "INPUT_ADMISSION_BUSY"` if any admission, active settlement, submitted mode-owned input, or undelivered native queue exists. This is a bounded zero-wait refusal; the old session stays open and usable. Settle the input or explicitly recover queues before retrying. It does not wait indefinitely for extension handlers or initiate model work to drain a queue.

After successful acquisition, new inputs reject with `INPUT_ADMISSION_FENCED`. Release reopens an unchanged session after cancellation/failure; it cannot release another operation's fence. Disposed sessions stay sealed and reject `INPUT_ADMISSION_DISPOSED`, even after release.

`AgentSessionRuntime.newSession()`, `switchSession()`, `fork()`, `importFromJsonl()` and `dispose()` hold this fence through before-switch/fork, abort/persistence, shutdown hooks, final disposal, and replacement completion. A rejected replacement is not a completed replacement. Do not bypass a busy refusal with direct session-manager mutation or raw agent methods. Native owner-allocation restrictions remain unchanged.

`AgentSession.dispose()` is synchronous and refuses active, admitted or queued work. First `await session.abort()` (which rejects still-admitted input with `INPUT_ADMISSION_ABORTED`), recover undelivered input if necessary, then dispose. Aborted hook completions cannot enqueue later. Runtime disposal performs the active-run abort/persistence itself after acquiring the fence. Its optional `beforeShutdown` callback runs inside that fence, for asynchronous host terminal teardown.

Orderly shutdown hosts may explicitly choose rejection instead of busy refusal with `fenceInputs({ rejectQueuedInput })` or `runtime.dispose({ rejectQueuedInput })`. Admission closes before abort yields, pending input rejects with `INPUT_ADMISSION_ABORTED`, and the synchronous callback receives every undelivered native message before queues are cleared. The callback must return only after issuing its authoritative receipt; a throwing callback leaves the queues intact and reopens admission. No input is implicitly replayed. `agent.getQueuedMessages()` snapshots both complete queues, independent of queue delivery mode.

The TUI renders a busy refusal without exiting, preserves input submitted after a fence in the editor, and does not stop the terminal before admission fencing succeeds.

## RPC shutdown receipts

Orderly stdin EOF, extension-requested shutdown and SIGTERM/SIGHUP reject still-admitted input through its correlated failure response. Already acknowledged but undelivered queued input is returned before disposal as `RpcInputRejectedEvent`:

```json
{"type":"input_rejected","reason":"shutdown","sessionId":"outgoing-session-id","error":"INPUT_ADMISSION_SHUTDOWN: queued input was not delivered","messages":[{"role":"user","content":[{"type":"text","text":"queued instruction"}],"timestamp":0}]}
```

`messages` contains the complete queued content, including image attachments. This is an authoritative terminal rejection receipt, not a success or an instruction to replay automatically. `RpcClient.onEvent()` exposes it and keeps reading through orderly `stop()` shutdown. Hard kills, crashes, transport loss, or a client force-kill timeout are not orderly shutdown guarantees; consumers still need their existing failure/no-replay protections.

## Integration gate

A host must detect version 1 on the reviewed installed runtime, consume state, busy refusals and terminal rejection receipts, then prove its own rotation and continuity behavior. This runtime contract alone does not authorize removing a production hold or bypassing independent owner acceptance gates.
