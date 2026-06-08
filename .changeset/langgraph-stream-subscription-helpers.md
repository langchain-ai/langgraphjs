---
"@langchain/langgraph": patch
---

Add the `@langchain/langgraph/stream` entrypoint — a transport-agnostic backend toolkit for building custom servers on top of the v2 streaming protocol. Alongside the existing `StreamChannel` and `convertToProtocolEvent`, it exposes subscription primitives, typed against a minimal `MatchableEvent` shape so they work on both the core `ProtocolEvent` and the wire-level `Event` from `@langchain/protocol`:

- `inferChannel(event)` — map an event to its subscription `Channel` (named `custom:<name>` channels included).
- `matchesSubscription(event, definition)` — decide whether a buffered event should be delivered for a `SubscribeParams` filter, honoring channel, namespace prefix/depth, and an optional `since` replay cursor.
- `isPrefixMatch(namespace, prefix)` / `normalizeNamespaceSegment(segment)` — namespace prefix matching with dynamic-suffix normalization (e.g. `fetcher:<uuid>` matches the `fetcher` prefix).
- `SUPPORTED_CHANNELS` / `isSupportedChannel(value)` — the recognized channel set and a guard for validating subscription requests.
