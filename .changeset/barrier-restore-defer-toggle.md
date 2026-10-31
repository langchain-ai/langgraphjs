---
"@langchain/langgraph": patch
---

fix(langgraph): restore barrier state across a defer flag change

`NamedBarrierValue` checkpoints its seen names as a bare list while the `defer: true` variant checkpoints `[seen, finished]`, and each `fromCheckpoint` assumed its own shape — so toggling `defer` on a fan-in node and resuming an existing thread corrupted the restored barrier silently: removing the flag left `seen` holding an array and a boolean, adding it left the characters of the first node name, and in both directions the waiting edge could never release again while `invoke()` resolved normally. Detect the other variant's shape and take the seen list either way, the same values a matching restore keeps. Threads checkpointed and resumed under one shape are unaffected.
