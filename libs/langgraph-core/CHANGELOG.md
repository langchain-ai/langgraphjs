# @langchain/langgraph

## 1.1.6

### Patch Changes

- [#1992](https://github.com/langchain-ai/langgraphjs/pull/1992) [`937f780`](https://github.com/langchain-ai/langgraphjs/commit/937f78030f1360251361c6096bbd0ff287662a2b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(core): don't trace channel read/writes

## 1.1.5

### Patch Changes

- Updated dependencies [[`242cfbb`](https://github.com/langchain-ai/langgraphjs/commit/242cfbbb6ab375c91bd021f64ec652840af591a9)]:
  - @langchain/langgraph-sdk@2.0.0

## 1.1.4

### Patch Changes

- Updated dependencies [[`8d5c2d6`](https://github.com/langchain-ai/langgraphjs/commit/8d5c2d688d330012638d8f34ce20a454600ebc1b)]:
  - @langchain/langgraph-sdk@1.6.0

## 1.1.3

### Patch Changes

- [#1932](https://github.com/langchain-ai/langgraphjs/pull/1932) [`0cda1f3`](https://github.com/langchain-ai/langgraphjs/commit/0cda1f3b78a86e7809b7db15a7ff0ea00ee1ecd8) Thanks [@samecrowder](https://github.com/samecrowder)! - fix: preserve `langgraph_type` metadata for LangSmith Studio tab detection

  - **Zod v4 `.register()` fix**: The metadata registry now properly stores and retrieves `langgraph_type` metadata when using Zod v4's `.register()` method with `MessagesZodMeta`
  - **StateSchema fix**: `StateSchema.getJsonSchema()` now correctly includes `jsonSchemaExtra` (like `langgraph_type: "messages"`) even when the underlying schema (e.g., `z.custom()`) doesn't produce a JSON schema

## 1.1.2

### Patch Changes

- [#1914](https://github.com/langchain-ai/langgraphjs/pull/1914) [`e60ec1b`](https://github.com/langchain-ai/langgraphjs/commit/e60ec1be6efc3b7fd1bde907de3d1d08fa2a0262) Thanks [@hntrl](https://github.com/hntrl)! - fix ConditionalEdgeRouter type rejection

- [#1916](https://github.com/langchain-ai/langgraphjs/pull/1916) [`9f34c8c`](https://github.com/langchain-ai/langgraphjs/commit/9f34c8ce420f44c604f12468806be807f7b372c1) Thanks [@hntrl](https://github.com/hntrl)! - Add unified schema support for `StateGraph` constructor

  - Support mixing `AnnotationRoot`, Zod schemas, and `StateSchema` for state, input, and output definitions
  - Add `{ input, output }` only pattern where state is inferred from input schema
  - Add per-node input schema support via `addNode` options
  - Deprecate `stateSchema` property in favor of `state`
  - Simplify constructor overloads with unified `StateGraphInit` type

- [#1918](https://github.com/langchain-ai/langgraphjs/pull/1918) [`cc12263`](https://github.com/langchain-ai/langgraphjs/commit/cc12263ad26804ef53760cabf1bd2fda0be575d6) Thanks [@hntrl](https://github.com/hntrl)! - Add type bag pattern for `GraphNode` and `ConditionalEdgeRouter` type utilities.

  **New types:**

  - `GraphNodeTypes<InputSchema, OutputSchema, ContextSchema, Nodes>` - Type bag interface for GraphNode
  - `GraphNodeReturnValue<Update, Nodes>` - Return type helper for node functions
  - `ConditionalEdgeRouterTypes<InputSchema, ContextSchema, Nodes>` - Type bag interface for ConditionalEdgeRouter

  **Usage:**

  Both `GraphNode` and `ConditionalEdgeRouter` now support two patterns:

  1. **Single schema** (backward compatible):

     ```typescript
     const node: GraphNode<typeof AgentState, MyContext, "agent" | "tool"> = ...
     ```

  2. **Type bag pattern** (new):
     ```typescript
     const node: GraphNode<{
       InputSchema: typeof InputSchema;
       OutputSchema: typeof OutputSchema;
       ContextSchema: typeof ContextSchema;
       Nodes: "agent" | "tool";
     }> = (state, runtime) => {
       // state type inferred from InputSchema
       // return type validated against OutputSchema
       // runtime.configurable type inferred from ContextSchema
       return { answer: "response" };
     };
     ```

  The type bag pattern enables nodes that receive a subset of state fields and return different fields, with full type safety.

## 1.1.1

### Patch Changes

- [#1912](https://github.com/langchain-ai/langgraphjs/pull/1912) [`4b2e448`](https://github.com/langchain-ai/langgraphjs/commit/4b2e448ed7c05be3a5f2cb07b28f3fabe4079c01) Thanks [@hntrl](https://github.com/hntrl)! - fix StateSchema/ReducedValue type inference

- Updated dependencies [[`98c0f26`](https://github.com/langchain-ai/langgraphjs/commit/98c0f26f4cc2c246359914704278ff5e3ae46a01), [`a3669be`](https://github.com/langchain-ai/langgraphjs/commit/a3669be176c5bca4b5bbcc6a6245882a684fb12f)]:
  - @langchain/langgraph-sdk@1.5.5

## 1.1.0

### Minor Changes

- [#1852](https://github.com/langchain-ai/langgraphjs/pull/1852) [`2ea3128`](https://github.com/langchain-ai/langgraphjs/commit/2ea3128ac48e52c9a180a9eb9d978dd9067ac80e) Thanks [@hntrl](https://github.com/hntrl)! - feat: add type utilities for authoring graph nodes and conditional edges

  New exported type utilities for improved TypeScript ergonomics:

  - `ExtractStateType<Schema>` - Extract the State type from any supported schema (StateSchema, AnnotationRoot, or Zod object)
  - `ExtractUpdateType<Schema>` - Extract the Update type (partial state for node returns) from any supported schema
  - `GraphNode<Schema, Context?, Nodes?>` - Strongly-typed utility for defining graph node functions with full inference for state, runtime context, and optional type-safe routing via Command
  - `ConditionalEdgeRouter<Schema, Context?, Nodes?>` - Type for conditional edge routing functions passed to `addConditionalEdges`

  These utilities enable defining nodes outside the StateGraph builder while maintaining full type safety:

  ```typescript
  import {
    StateSchema,
    GraphNode,
    ConditionalEdgeRouter,
    END,
  } from "@langchain/langgraph";
  import { z } from "zod/v4";

  const AgentState = new StateSchema({
    messages: MessagesValue,
    step: z.number().default(0),
  });

  interface MyContext {
    userId: string;
  }

  // Fully typed node function
  const processNode: GraphNode<typeof AgentState> = (state, runtime) => {
    return { step: state.step + 1 };
  };

  // Type-safe routing with Command
  const routerNode: GraphNode<
    typeof AgentState,
    MyContext,
    "agent" | "tool"
  > = (state) => new Command({ goto: state.needsTool ? "tool" : "agent" });

  // Conditional edge router
  const router: ConditionalEdgeRouter<
    typeof AgentState,
    MyContext,
    "continue"
  > = (state) => (state.done ? END : "continue");
  ```

- [#1842](https://github.com/langchain-ai/langgraphjs/pull/1842) [`7ddf854`](https://github.com/langchain-ai/langgraphjs/commit/7ddf85468f01b8cfea62b1c513e04bd578580444) Thanks [@hntrl](https://github.com/hntrl)! - feat: `StateSchema`, `ReducedValue`, and `UntrackedValue`

  **StateSchema** provides a new API for defining graph state that works with any [Standard Schema](https://github.com/standard-schema/standard-schema)-compliant validation library (Zod, Valibot, ArkType, and others).

  ### Standard Schema support

  LangGraph now supports [Standard Schema](https://standardschema.dev/), an open specification implemented by Zod 4, Valibot, ArkType, and other schema libraries. This means you can use your preferred validation library without lock-in:

  ```typescript
  import { z } from "zod"; // or valibot, arktype, etc.
  import {
    StateSchema,
    ReducedValue,
    MessagesValue,
  } from "@langchain/langgraph";

  const AgentState = new StateSchema({
    messages: MessagesValue,
    currentStep: z.string(),
    count: z.number().default(0),
    history: new ReducedValue(
      z.array(z.string()).default(() => []),
      {
        inputSchema: z.string(),
        reducer: (current, next) => [...current, next],
      }
    ),
  });

  // Type-safe state and update types
  type State = typeof AgentState.State;
  type Update = typeof AgentState.Update;

  const graph = new StateGraph(AgentState)
    .addNode("agent", (state) => ({ count: state.count + 1 }))
    .addEdge(START, "agent")
    .addEdge("agent", END)
    .compile();
  ```

  ### New exports

  - **`StateSchema`** - Define state with any Standard Schema-compliant library
  - **`ReducedValue`** - Define fields with custom reducer functions for accumulating state
  - **`UntrackedValue`** - Define transient fields that are not persisted to checkpoints
  - **`MessagesValue`** - Pre-built message list channel with add/remove semantics

### Patch Changes

- [#1901](https://github.com/langchain-ai/langgraphjs/pull/1901) [`6d8f3ed`](https://github.com/langchain-ai/langgraphjs/commit/6d8f3ed4c879419d941a25ee48bed0d5545add4d) Thanks [@dqbd](https://github.com/dqbd)! - Perform reference equality check on reducers before throwing "Channel already exists with a different type" error

- Updated dependencies [[`5629d46`](https://github.com/langchain-ai/langgraphjs/commit/5629d46362509f506ab455389e600eff7d9b34bb), [`78743d6`](https://github.com/langchain-ai/langgraphjs/commit/78743d6bca96945d574713ffefe32b04a4c04d29)]:
  - @langchain/langgraph-sdk@1.5.4

## 1.0.15

### Patch Changes

- Updated dependencies [[`344b2d2`](https://github.com/langchain-ai/langgraphjs/commit/344b2d2c1a6dca43e9b01e436b00bca393bc9538), [`84a636e`](https://github.com/langchain-ai/langgraphjs/commit/84a636e52f7d3a4b97ae69d050efd9ca0224c6ca), [`2b9f3ee`](https://github.com/langchain-ai/langgraphjs/commit/2b9f3ee83d0b8ba023e7a52b938260af3f6433d4)]:
  - @langchain/langgraph-sdk@1.5.0

## 1.0.14

### Patch Changes

- [#1862](https://github.com/langchain-ai/langgraphjs/pull/1862) [`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c) Thanks [@dqbd](https://github.com/dqbd)! - retry release: improved Zod interop

- Updated dependencies [[`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c)]:
  - @langchain/langgraph-sdk@1.4.6

## 1.0.13

### Patch Changes

- [#1856](https://github.com/langchain-ai/langgraphjs/pull/1856) [`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: improved Zod interop

- Updated dependencies [[`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217)]:
  - @langchain/langgraph-sdk@1.4.5

## 1.0.12

### Patch Changes

- [#1853](https://github.com/langchain-ai/langgraphjs/pull/1853) [`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: improved Zod interop

- Updated dependencies [[`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e)]:
  - @langchain/langgraph-sdk@1.4.4

## 1.0.11

### Patch Changes

- [#1850](https://github.com/langchain-ai/langgraphjs/pull/1850) [`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: improved Zod interop

- Updated dependencies [[`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd)]:
  - @langchain/langgraph-sdk@1.4.3

## 1.0.10

### Patch Changes

- 3ec85a4: retry release: improved Zod interop
- Updated dependencies [3ec85a4]
  - @langchain/langgraph-sdk@1.4.2

## 1.0.9

### Patch Changes

- 3613386: retry release: improved Zod interop
- Updated dependencies [3613386]
  - @langchain/langgraph-sdk@1.4.1

## 1.0.8

### Patch Changes

- 730dc7c: fix(core): improved Zod interop
- Updated dependencies [730dc7c]
- Updated dependencies [4ffdde9]
- Updated dependencies [730dc7c]
  - @langchain/langgraph-sdk@1.4.0

## 1.0.7

### Patch Changes

- f602df6: Adding support for resumableStreams on remote graphs.

## 1.0.6

### Patch Changes

- de1454a: undeprecate toolsCondition
- 2340a54: respect meta defaults in `LastValue`

## 1.0.5

### Patch Changes

- Updated dependencies [1497df9]
  - @langchain/langgraph-sdk@1.3.0

## 1.0.4

### Patch Changes

- Updated dependencies [379de5e]
- Updated dependencies [d08e484]
- Updated dependencies [d08e484]
  - @langchain/langgraph-sdk@1.2.0

## 1.0.3

### Patch Changes

- Updated dependencies [e19e76c]
- Updated dependencies [fa6c009]
- Updated dependencies [35e8fc7]
- Updated dependencies [b78a738]
  - @langchain/langgraph-sdk@1.1.0

## 1.0.2

### Patch Changes

- 4a6bde2: remove interrupt deprecations docs

## 1.0.1

### Patch Changes

- 4c4125c: undeprecate `ToolNode`

## 1.0.0

### Major Changes

- 1e1ecbb: Make Zod a peer dependency of @langchain/langgraph
- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- 1e1ecbb: Fix type issue with defining `interrupt` and `writer` in StateGraph constructor when using Annotation.Root
- 1e1ecbb: Add `pushMessage` method for manually publishing to messages stream channel
- 1e1ecbb: chore(prebuilt): deprecate createReactAgent
- 1e1ecbb: Improve performance of scheduling tasks with large graphs
- 1e1ecbb: Improve graph execution performance by avoiding unnecessary cloning of checkpoints after every tick
- 1e1ecbb: fix(@langchain/langgraph): export missing `CommandParams` symbol
- 1e1ecbb: Add `stream.encoding` option to emit LangGraph API events as Server-Sent Events. This allows for sending events through the wire by piping the stream to a `Response` object.
- 1e1ecbb: fix(@langchain/langgraph): export missing `CommandInstance` symbol
- 1e1ecbb: Update troubleshooting link for common errors, add MISSING_CHECKPOINTER troubleshooting page
- 1e1ecbb: Fix `stateKey` property in `pushMessage` being ignored when RunnableConfig is automatically inherited
- 1e1ecbb: Improve tick performance by detecting interrupts faster within a tick.
- 1e1ecbb: Improve tick performance by calling `maxChannelMapVersion` only once
- 1e1ecbb: feat(langgraph): add `toLangGraphEventStream` method to stream events in LGP compatible format
- 1e1ecbb: fix(createReactAgent): update deprecation messages to contain reactAgent
- 1e1ecbb: `writer`, `interrupt` and `signal` is no longer an optional property of `Runtime`
- 1e1ecbb: Add support for defining multiple interrupts in StateGraph constructor. Interrupts from the map can be picked from the `Runtime` object, ensuring type-safety across multiple interrupts.
- 1e1ecbb: Channels are now part of the public API, allowing users to customise behaviour of checkpointing per channel (#976)
- 1e1ecbb: Allow defining types for interrupt and custom events upfront
- 1e1ecbb: Fix performance regression due to deferred nodes
- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0
  - @langchain/langgraph-sdk@1.0.0

## 1.0.0-alpha.5

### Patch Changes

- b6d6701: fix(@langchain/langgraph): export missing `CommandParams` symbol
- d5be09c: fix(@langchain/langgraph): export missing `CommandInstance` symbol

## 1.0.0-alpha.4

### Patch Changes

- c3f326d: Add support for defining multiple interrupts in StateGraph constructor. Interrupts from the map can be picked from the `Runtime` object, ensuring type-safety across multiple interrupts.

## 1.0.0-alpha.3

### Patch Changes

- 05619e2: Add `stream.encoding` option to emit LangGraph API events as Server-Sent Events. This allows for sending events through the wire by piping the stream to a `Response` object.
- 14cb042: Fix `stateKey` property in `pushMessage` being ignored when RunnableConfig is automatically inherited

## 1.0.0-alpha.2

### Patch Changes

- a5bcd74: Fix type issue with defining `interrupt` and `writer` in StateGraph constructor when using Annotation.Root
- 5184725: Add `pushMessage` method for manually publishing to messages stream channel

## 1.0.0-alpha.1

### Patch Changes

- a05436d: Improve performance of scheduling tasks with large graphs
- d35db59: Improve graph execution performance by avoiding unnecessary cloning of checkpoints after every tick
- 7e01d08: Update troubleshooting link for common errors, add MISSING_CHECKPOINTER troubleshooting page
- a527fc7: Improve tick performance by detecting interrupts faster within a tick.
- 27934c0: Improve tick performance by calling `maxChannelMapVersion` only once
- dc2e5f2: fix(createReactAgent): update deprecation messages to contain reactAgent
- e8f5084: `writer`, `interrupt` and `signal` is no longer an optional property of `Runtime`
- 20f1d64: Channels are now part of the public API, allowing users to customise behaviour of checkpointing per channel (#976)
- 2311efc: Allow defining types for interrupt and custom events upfront
- c6f75b6: Fix performance regression due to deferred nodes

## 1.0.0-alpha.0

### Major Changes

- 445c2ae: Make Zod a peer dependency of @langchain/langgraph

### Patch Changes

- 5f9b5a0: Deprecate createReactAgent in favour of `langchain` package.
- dcc117f: feat(langgraph): add `toLangGraphEventStream` method to stream events in LGP compatible format

## 0.4.9

### Patch Changes

- Updated dependencies [35a0f1c]
- Updated dependencies [35a0f1c]
- Updated dependencies [35a0f1c]
- Updated dependencies [35a0f1c]
  - @langchain/langgraph-sdk@0.1.0

## 0.4.8

### Patch Changes

- bb0df7c: Fix "This stream has already been locked for exclusive reading by another reader" error when using `web-streams-polyfill`

## 0.4.7

### Patch Changes

- 60e9258: fix(langgraph): task result from stream mode debug / tasks should match format from getStateHistory / getState
- 07a5b2f: fix(langgraph): avoid accepting incorrect keys in withLangGraph
- Updated dependencies [b5f14d0]
  - @langchain/langgraph-sdk@0.0.111

## 0.4.6

### Patch Changes

- 5f1db81: fix(langgraph): `withConfig` should accept `context`
- c53ca47: Avoid iterating on channels if no managed values are present
- a3707fb: fix(langgraph): allow `updateState` after resuming from an interrupt
- Updated dependencies [e8b4540]
- Updated dependencies [9c57526]
  - @langchain/langgraph-sdk@0.0.109

## 0.4.5

### Patch Changes

- d22113a: fix(pregel/utils): propagate abort reason in combineAbortSignals
- 2284045: fix(langgraph): send checkpoint namespace when yielding custom events in subgraphs
- 4774013: fix(langgraph): persist resume map values

## 0.4.4

### Patch Changes

- 8f4acc0: feat(langgraph): speed up prepareSingleTask by 20x
- 8152a15: Use return type of nodes for streamMode: updates types
- 4e854b2: fix(langgraph): set status for tool messages generated by ToolNode
- cb4b17a: feat(langgraph): use createReactAgent description for supervisor agent handoffs
- Updated dependencies [72386a4]
- Updated dependencies [3ee5c20]
  - @langchain/langgraph-sdk@0.0.107

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
