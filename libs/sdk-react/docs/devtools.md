# Received-event recording and replay (proof of concept)

`StreamDevtoolsSession` is an opt-in bridge for tools that record the current
`@langchain/react` `useStream` hook. It has no UI, persistence, or TanStack
dependency. It does not support the legacy SDK React hook.

```tsx
import { useState } from "react";
import { useStream } from "@langchain/react";
import {
  StreamDevtoolsSession,
  type StreamDevtoolsRecord,
} from "@langchain/langgraph-sdk/stream";

function Chat({ append }: { append: (record: StreamDevtoolsRecord) => void }) {
  const [devtools] = useState(
    () => new StreamDevtoolsSession({ onRecord: append })
  );
  const stream = useStream({ assistantId: "agent", devtools });
  return <pre>{JSON.stringify(stream.values)}</pre>;
}
```

Keep one stable session per mounted hook. `onRecord(record)` runs synchronously
in delivery order. It receives detached, JSON-compatible objects: a version-1
`baseline` at attachment and hydration boundaries, and `event` records tagged
with `source: "root" | "wildcard"`. The two sources can deliver the same
protocol event; preserve both deliveries and their order, rather than sorting
by sequence number or deduplicating. Queue asynchronous disk writes in that
same order. The initial callback can run during React rendering; do not
synchronously update React state from it. Defer UI notifications outside the
render phase while preserving record order. Recording failures warn without
interrupting the live stream.

A baseline contains serialized root values/messages, tool calls, interrupts,
loading flags, thread ID, and checkpoint seed metadata. Event records contain
the protocol `Event` as received by the controller. The SDK keeps no recording
history; persistence and retention belong to the caller.

To seek, replay the persisted prefix beginning at the recording's first
baseline. Do not use an arbitrary state snapshot as a mid-message checkpoint:
partial message/tool assemblers are reconstructed from their start events.

```ts
devtools.reset();
for await (const record of readRecordingPrefixFromDisk()) {
  devtools.apply(record);
}
devtools.flush();

devtools.live();
```

`reset()` discards the previous replay controller and selects a new isolated
one. `apply()` uses the actual controller's root message, value, tool, lifecycle,
and received-input assembly paths. `flush()` synchronously flushes pending
message and terminal-loading updates. Mounted hook state follows this replay
controller. Repeated seeks do not accumulate controllers or retain prefixes.
`getSnapshot()` returns `"live" | "replay"`; `subscribe(listener)` observes
session changes.

The live controller keeps receiving and recording while a prefix is displayed.
`live()` restores that continuously advancing state, not the state at which
playback began. Hook `submit`, `respond`, `respondAll`, `stop`, and `disconnect`
reject during playback, including previously captured method references.
Playback does not open transports, fetch history/state, run headless tools,
invoke run callbacks, dispatch commands, or fan events into channel effects.
`getThread()` returns no thread in playback. The exposed `client` is still the
caller's live client: the session cannot intercept application code that calls
it directly. Existing live requests and callbacks are not cancelled by seeking.

## Completeness boundaries

This is received-event inspection, **not deterministic replay of every UI or
server transition**. It supports root hook values/messages/tool calls and the
root loading/received-input projections, subject to these limits:

- There is no local-command journal. Optimistic messages and pending/failed
  delivery statuses, queued submissions, local loading changes, resume-response
  barriers, and command error/reconciliation state are not reconstructed.
- Input replay applies received requests/answers with the baseline timestamp
  floor. It does not reproduce the live controller's command-dependent pending
  interrupt filtering or server reconciliation; pending interrupts can differ.
- Scoped selectors, arbitrary custom channels, media handles, history-derived
  metadata, and complete subagent/subgraph discovery are outside the PoC.
  They must not be presented as complete replay views. Replay never opens
  lazy subscriptions to fill these gaps.
- Baselines omit errors and contain only JSON-compatible state. Custom class
  instances (other than supported messages), binary handles, cyclic values,
  and non-JSON state require an application-specific recording policy.
- Hydration baselines reset the root seed; they are not general-purpose
  resumable assembler checkpoints. For dependable token reconstruction,
  replay the ordered prefix from the beginning.

Recordings may contain prompts, model output, tool arguments/results, and other
sensitive state. Nothing is persisted automatically and no credentials are
recorded by the bridge itself. The caller must decide consent, redaction,
access control, retention, and write-queue backpressure. Record only trusted
application sessions; this prototype is not a hardened import format for
untrusted recording files.
