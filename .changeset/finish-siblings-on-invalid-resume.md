---
"@langchain/langgraph": patch
---

When one answer in a multi-answer resume fails its interrupt's `responseSchema`, the other tasks in the step now finish before the `ZodError` is thrown, instead of being aborted. A task aborted after its side effects kept its answer and ran again on the next resume. The error is unchanged, and the new `isInvalidResume(error)` tells it apart from other errors, as `is_invalid_resume` does in langgraph (Python).
