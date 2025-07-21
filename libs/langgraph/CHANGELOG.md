# @langchain/langgraph

## 0.3.11

### Patch Changes

- a0efb98: Relax `when` type for `Interrupt`
- Updated dependencies [a0efb98]
  - @langchain/langgraph-sdk@0.0.100

## 0.3.10

### Patch Changes

- a12c1fb: fix(langgraph): stop suggesting public properties and methods of Command when calling invoke
- Updated dependencies [ee1defa]
  - @langchain/langgraph-sdk@0.0.98

## 0.3.9

### Patch Changes

- 430ae93: feat(langgraph): validate if messages present in user provided schema
- 4aed3f4: fix(langgraph): dispose unused combined signals
- 02f9e02: fix(langgraph): preModelHook `llmInputMessages` should not keep concatenating messages
- 6e616f5: fix(langgraph): respect strict option in responseFormat inside createReactAgent
- 6812b50: feat(langgraph): allow extending state with Zod schema
- 8166703: add UpdateType type utility for Zod, improve Zod 4 and Zod 4 mini support
- Updated dependencies [53b8c30]
  - @langchain/langgraph-sdk@0.0.96

## 0.3.8

### Patch Changes

- fix(langgraph): Ensure resuming only happens with matching run ids by @hinthornw in https://github.com/langchain-ai/langgraphjs/pull/1381

## 0.3.7

### Patch Changes

- fix(langgraph): Handle wrapped LLM models in createReactAgent (RunnableSequence, withConfig, ...etc) by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1369
- fix(langgraph): avoid calling \_emit for runs without metadata by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1340
- fix(langgraph): fail fast when interrupt is called without checkpointer by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1343
- fix(langgraph): handle wrapped LLM models in createReactAgent by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1369
