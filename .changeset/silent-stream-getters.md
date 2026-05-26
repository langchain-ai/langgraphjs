---
"@langchain/langgraph-sdk": patch
---

fix(react): avoid eager stream getter evaluation during object spread

Mark optional `useStream` accessors as non-enumerable so object spread/rest destructuring does not accidentally read guarded fields like `history` or opt into additional stream modes.
