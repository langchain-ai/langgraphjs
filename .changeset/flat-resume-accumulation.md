---
"@langchain/langgraph": patch
---

fix(langgraph): accumulate interrupt resumes as a flat list

Successive `Command({ resume: { [interruptId]: value } })` writes were nesting
the prior `__resume__` list (`[[["m1"],"m2"],"m3"]…`) because `mapCommand`
treated the previous write's value as a single element. `_scratchpad` only
`.flat()`s one level, so later resumes broke. Concatenate with `.flat()` first,
matching Python LangGraph's flat accumulation.
