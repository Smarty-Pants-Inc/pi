# Turn provenance

New user and custom-message session entries carry an optional `provenance`
record. It describes one received turn, not the text's claims about its sender.
The record lives on the [JSONL entry](session-format.md), outside the message
content and outside provider requests.

## Version 1

```typescript
interface TurnProvenance {
  v: 1;
  turnId: string;
  receivedAt: string;
  channel: "terminal" | "keyboard" | "voice" | "fabric";
  principal?: { id: string; binding: "herdr-client" | "voice-call" };
  sender?: {
    id: string;
    kind: "main" | "actor" | "agent" | "remote";
    name?: string;
    verified: "mesh" | "bridge";
  };
  via?: "steer" | "followUp" | "actor" | "replay";
  submissionToken?: string;
}
```

The exported TypeScript type constrains fields by channel: `keyboard` requires
an `herdr-client` principal; `voice` requires a `voice-call` principal; `fabric`
requires a sender and may contain `via`. `terminal` contains no principal,
sender, or `via`.

`turnId` is a harness-generated UUID. `receivedAt` is the UTC ISO timestamp at
first turn receipt through normal `AgentSession` and CLI/mode APIs. Automatic
buffering and dispatch retain that receipt; separate occurrences receive
separate IDs. Reload, compaction, fork, branch, and export preserve existing
records. Older turns are not backfilled.

Low-level `session.agent.prompt`, `steer`, and `followUp` bypass those admission
points. Their fresh terminal receipt records **first harness observation** at
`message_start`, not raw API enqueue time and never the caller's message timestamp.
Use `AgentSession` methods for first-receipt accounting. Raw Agent admission timing
remains a separate follow-up ([smarty-dev#2867](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/2867)).

## Current behavior: UNKNOWN

This release writes only `channel: "terminal"`. It does not identify a person
or a verified Fabric participant. Treat these records as **UNKNOWN** for
statement ownership, including editor input and voice/Fabric extension sends.
Text labels, extra RPC fields, extension options, and setup appends do not
install caller-selected attribution.

The other channels define the persisted format for later trusted integrations.
There is no provenance claim API, trust setting, keyboard attestation, or
`hostCapabilities.turnProvenance` capability in this release.

`submissionToken` is reserved for a later trusted editor-submit integration.
It is opaque correlation data, not an identity proof or caller capability.
Current receipt writers neither generate nor consume it. A later Pi/Herdr
integration must synchronize the exact draft boundary with ordered input
receipts before clearing or reusing the editor; a token or a late query alone
cannot provide that boundary.

## Reading records

Use `getTurnProvenance(entry)` from `@earendil-works/pi-coding-agent`. It returns
a detached v1 record or `undefined` for old, missing, unknown-version, or
malformed metadata. It validates UUIDs, canonical UTC timestamps, bounded
identity strings, and channel-specific fields.

The reader validates the format; it does not authenticate edits to a session
file. Consumers must still enforce their session-storage trust boundary and
must never infer identity from message text. See [Session storage](sdk.md#sessionmanager-api).
