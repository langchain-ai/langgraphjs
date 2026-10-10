---
"@langchain/langgraph": patch
---

A run's input to a DeltaChannel input channel of a raw `Pregel` graph reads back only on the checkpoints built from it. With `"sync"` or `"async"` durability it was saved as the starting checkpoint's own state: on a new thread the first run's input was lost, the previous run's last checkpoint read the next run's input, and a run from an older checkpoint leaked its input into the branch that already grew from it. Now the input is stored on the starting checkpoint under its own task id, or, on a new thread or an addressed checkpoint, the input checkpoint snapshots the channel. Threads saved before this keep the input already stored on their checkpoints.
