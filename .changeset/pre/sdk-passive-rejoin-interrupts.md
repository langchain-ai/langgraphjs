---
"@langchain/langgraph-sdk": patch
---

fix(sdk): show interrupts raised after a passive thread rejoin

After a page refresh mid-run, `useStream` filtered every interrupt it did not
already know from the hydrated thread state as replayed history, and waited
for a `checkpoints` event to lift that filter. Current runtimes never emit
that event and the replay buffer trims it on long runs, so interrupts raised
after the refresh never appeared until the next reload. Unknown interrupts are
now settled against the server's thread state when the run reaches a terminal
lifecycle: the ones the server lists as pending are shown, the rest are
dropped as history.
