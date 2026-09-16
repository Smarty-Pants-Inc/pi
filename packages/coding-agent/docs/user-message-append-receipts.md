# User-message append receipts

`pi.sendUserMessage()` remains fire-and-forget. Its events and the in-memory
session tree do not prove persistence. Use the additive
`pi.sendUserMessageWithReceipt(content, options)` when a caller must distinguish
an original-writer append from input handling or failure. The SDK exposes the
same method on `AgentSession`.

```ts
if (typeof pi.sendUserMessageWithReceipt !== "function") {
  throw new Error("Native user-message append receipts are unavailable");
}
const receipt = await pi.sendUserMessageWithReceipt(text, { deliverAs: "followUp" });
if (receipt.status === "appended" && !receipt.contentChanged) {
  // Associate this invocation with receipt.sessionId and receipt.entryId.
  // receipt.parentId is the actual selected parent at the append boundary.
}
```

The Promise belongs to this invocation. Pi privately associates the actual user
message object with it through input preparation and native steering/follow-up
queues. It does not match text, inspect the latest entry, poll the journal, or
use a second writer. Options and input interception are the same as
`sendUserMessage()`. A foreign message with equal text cannot resolve this call.

## Outcomes

- `appended`: the original SessionManager completed its synchronous writes and
  close, then indexed the entry. Includes `sessionId`, `sessionFile`, `entryId`,
  `parentId`, and `contentChanged`. This is **not** an fsync/power-loss durability,
  provider-completion, human-acceptance, or network-delivery receipt.
- `memory`: the original manager is in-memory only. Includes the entry identity,
  but no file persistence is claimed.
- `deferred`: no file append is proved. The shared manager receipt type reserves
  this state; the receipt-enabled user path currently forces initial persistence
  and does not return it. Legacy `appendMessage()` still buffers before the first
  assistant on a new file.
- `handled`: an input handler or extension command handled the submission. No
  correlated native user append is claimed, even if the handler writes other
  entries or starts another submission.
- `not_written`: this submission was not appended. For example, preflight failed,
  a queue was cleared, the session was disposed, or opening the file failed.
- `unknown`: a write/close may have partially succeeded, or the append boundary
  could not establish a reliable outcome. Preserve custody; do not resend.

`contentChanged` compares the final normalized user content with the normalized
content supplied by this call. Input hooks, template expansion, and message-end
hooks can change it. An appended transformed message is not an acknowledgement
that the caller's original content was preserved. Receipt identity—not this
content comparison—provides correlation.

A new receipt-enabled file is created exclusively and receives the existing
buffered entries plus this user entry. It does not need an assistant seed turn.
An existing file must still exist. No append path truncates or restores the file.
The method resolves at append, before waiting for provider completion. Later
provider failure does not revoke an already successful receipt.

## Failure and lifetime

`SessionManager.appendMessage()` retains its string entry-ID return. Persistence
failure now leaves its indexes and leaf unchanged. `SessionPersistenceError`
retains the original error as `cause`, including a string error `code`, plus the
attempted entry and original file/session identity. `outcome` is `not_written`
when failure preceded a write call; after a write attempt or uncertain close it
is conservatively `unknown`.

An unknown append fences further writes and file replacement on that manager.
`getPersistenceError()` exposes the first uncertainty for read-only diagnosis.
Do not reopen the file through the normal loader to reconcile it: that loader
has separate legacy tail-repair behavior. This contribution does not add an
automatic repair or recovery operation.

Queued receipt Promises can remain pending while input remains queued. Clearing
the queue or disposing the session resolves undelivered inputs as `not_written`.
Do not await a queued receipt inside a tool/event that must finish before the
queue can run. Loss of the process or transport before the caller observes a
receipt is an unknown caller outcome, not permission to resend. This API adds
no reconnect ledger or cross-process receipt replay.

Old Pi versions lack the method. Custom extension hosts without its native
action reject explicitly; there is no fallback to `sendUserMessage()`, idle
state, or transcript inspection. Consumers must fail closed on absence.
