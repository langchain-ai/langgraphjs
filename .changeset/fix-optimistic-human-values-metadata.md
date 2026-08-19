---
"@langchain/langgraph-sdk": patch
---

fix(sdk): adopt server metadata on same-id optimistic message echo

When a `values` snapshot echoes an optimistic human with the same
content plus committed `additional_kwargs` (e.g. attachment paths),
`stream.messages` now takes the server copy instead of keeping the
plain optimistic message until hydration. Preferring is asymmetric:
lagging or poorer values snapshots do not strip richer current
metadata. In-flight AI token streaming is unchanged: streamed content
still wins when it has moved past the snapshot.
