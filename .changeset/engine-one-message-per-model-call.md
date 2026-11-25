---
"@langchain/langgraph-sdk": patch
---

A reply from a Python graph whose model names it in its first streamed chunk only, such as `ChatOpenAI` on the Responses API, now streams as one message under that id, the one its saved message keeps. Before, the stream held an empty message under the provider's id and the reply under `lc_run--<run id>` until the run ended and the thread was read again. A join that replays a run also leaves a message the page shows as it read it alone while it is shown. Its replayed chunks used to blank it, then stream it again from the start. `useStream` from `@langchain/langgraph-sdk/react` gets the same fixes.
