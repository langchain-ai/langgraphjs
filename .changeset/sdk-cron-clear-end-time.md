---
"@langchain/langgraph-sdk": patch
---

fix(sdk): support clearing a cron's end time via `crons.update(cronId, { endTime: null })`

`CronsClient.update` now accepts `endTime: null` to clear a previously set cron end time; omitting `endTime` still leaves it unchanged. The field was typed `string`, so callers could not express "clear" even though the request already forwards an explicit `null`.
