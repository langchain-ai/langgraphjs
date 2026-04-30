---
"@langchain/langgraph-checkpoint": patch
---

fix: restrict JsonPlusSerializer's load() call to an allowlist of safe LangChain id namespaces (messages, documents, prompt_values, outputs) to close an insecure-deserialization sink in checkpoint restore. Other namespaces pass through as plain objects; apps can extend the allowlist via the new `JsonPlusSerializerOptions.loadableLangChainPrefixes` option.
