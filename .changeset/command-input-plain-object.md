---
"@langchain/langgraph": patch
---

fix(langgraph): `isCommand` no longer accepts plain objects, so JSON graph input shaped like `{ lg_name: "Command", goto, update }` is treated as ordinary state input instead of a control directive. `Command` instances, including ones built by another installed copy of `@langchain/langgraph`, are still recognized. To pass a command as input, construct it with `new Command(...)`.
