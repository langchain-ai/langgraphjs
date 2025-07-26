---
"@langchain/langgraph-sdk": patch
---

Fixed getBranchSequence function returning empty branch tree when fetchStateHistory uses a limit parameter.

WHAT: The getBranchSequence helper would return an empty rootSequence when the history slice didn't include the very first checkpoint (whose parent is null). This caused useStream to return empty messages and history arrays when using fetchStateHistory with limit options.

WHY: When requesting limited history (e.g. fetchStateHistory: { limit: 5 }), the API doesn't return the root checkpoint. The branch tree algorithm looks for children of the synthetic root "$" but finds none, resulting in empty trees and no messages displayed to users.

HOW: No code changes required for consumers. The fix is internal to the SDK. Apps using fetchStateHistory with limit parameters will now correctly receive message arrays instead of empty results.
