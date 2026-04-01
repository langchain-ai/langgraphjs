---
"@langchain/langgraph-sdk": patch
---

Restore deprecated snake_case aliases on human-in-the-loop interrupt payloads
while preserving the newer camelCase fields so older apps can migrate to
`@langchain/react` without breaking interrupt handling.
