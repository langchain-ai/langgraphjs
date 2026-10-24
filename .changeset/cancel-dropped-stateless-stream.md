---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): cancel a stateless streamed run when its request drops and `on_disconnect` is `cancel`

`POST /runs/stream` never cancelled its run when the client went away, before or after the response started, because the stream only cancelled runs it joined with a thread id. A stateless run created with `on_disconnect: "cancel"` now stops when its request drops, as thread runs already did, and `GET /runs/:run_id/stream?cancel_on_disconnect=true` gets the same fix. Cancelling a stateless run that has not started yet now deletes the run, and its temporary thread when no other run is left on it, instead of leaving an `interrupted` run and its thread behind. Runs created with `on_disconnect: "continue"` keep running.
