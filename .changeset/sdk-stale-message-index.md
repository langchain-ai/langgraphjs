---
"@langchain/langgraph-sdk": patch
---

fix(sdk): write streamed messages at their current index

A `values` event can replace and reorder `messages`, but the manager kept the index a message got when its id was first streamed. The next chunk could overwrite a different message and leave the real one duplicated; a `remove` chunk could delete the wrong one. The write index is now resolved against the current message list.
