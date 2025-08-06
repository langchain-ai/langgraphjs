# @langchain/langgraph

## 0.4.3

### Patch Changes

- f69bf6d: feat(langgraph): createReactAgent v2: use Send for each of the tool calls
- 9940200: feat(langgraph): Allow partially applying tool calls via postModelHook
- e8c61bb: feat(langgraph): add dynamic model choice to createReactAgent

## 0.4.2

### Patch Changes

- c911c5f: fix(langgraph): handle empty messages

## 0.4.1

### Patch Changes

- f2cc704: fix(langgraph): RemotePregel serialization fix
- Updated dependencies [7054a6a]
  - @langchain/langgraph-sdk@0.0.105

## 0.4.0

### Minor Changes

- 5f7ee26: feat(langgraph): cleanup of interrupt interface
- 10432a4: chore(langgraph): remove SharedValue / managed values
- f1bcec7: chore(langgraph): introduce `context` field and `Runtime` type
- 14dd523: fix(langgraph): auto-inference of configurable fields
- fa78796: Add `durability` checkpointer mode
- 565f472: Mark StateGraph({ channel }) constructor deprecated

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [f1bcec7]
- Updated dependencies [3fd7f73]
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0
  - @langchain/langgraph-sdk@0.0.103

## 0.3.12

### Patch Changes

- 034730f: fix(langgraph): add support for new interrupt ID

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
