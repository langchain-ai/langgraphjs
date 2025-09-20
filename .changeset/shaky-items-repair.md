---
"@langchain/langgraph": patch
---

Add support for defining multiple interrupts in StateGraph constructor. Interrupts from the map can be picked from the `Runtime` object, ensuring type-safety across multiple interrupts.
