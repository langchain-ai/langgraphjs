---
"@langchain/langgraph": patch
---

fix(langgraph): keep every message a node returns in messages stream mode

- In `streamMode: "messages"`, the id-less messages a node returned all got one id, and an id-less message could take the id of a sibling that had one, so the messages reducer kept only one of them and the saved state depended on the stream mode. Each id-less message of a node's output now gets its own id.
- Messages a node returns through `Command({ update })` are now emitted in `messages` mode, as in Python. So are all the messages of a list of updates that holds a `Command`, such as `ToolNode` returns when one of its tools returns a `Command`; before, none of that list's messages were emitted, and they reached clients only with the next `values` event.
- A model tagged `nostream` still streams no tokens, but when its node returns its message in a list with a `Command`, as `createAgent` does, that message now streams whole when the node ends, as it already did for a plain update and does in Python.

`streamEvents` with `version: "v3"` is unchanged.
