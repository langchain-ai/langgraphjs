---
"@langchain/langgraph-checkpoint-mongodb": major
---

Reject slash-containing namespace labels on writes, verify vector results against namespace arrays to exclude legacy encoding collisions, and treat listing labels as literal values. Existing data and indexes need no migration. Legacy slash-containing records remain readable and deletable, but must be renamed before updating; vector collisions may produce short result pages.
