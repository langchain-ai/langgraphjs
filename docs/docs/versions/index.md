# LangGraph Over Time

As LangGraph.js continues to evolve and improve, breaking changes are sometimes necessary to enhance functionality, performance, or developer experience. This page serves as a guide to the version history of LangGraph.js, documenting significant changes and providing assistance for upgrading between versions.

## Version History

### v0.3.0 (Latest)

- (Breaking) Interrupts are now properly propagated in `"values"` stream mode and in `.invoke()`.
- (Breaking) Return type of `.stream()` is now strictly typed.
- Added support for [node / task caching](/langgraphjs/how-tos/node-caching/).
- Added support for [deferred nodes](/langgraphjs/how-tos/defer-node-execution/).
- Added support for `preModelHook` and `postModelHook` in `createReactAgent`.
- Added support for `addSequence` and shorthand object syntax for `addNode`.
- Added `pushMessage()` method to allow manually pushing messages to `"messages"` stream mode.
- Added `isInterrupted()` method to check if the state contains an interrupt.
- Numerous bugfixes.

### v0.2.0

- (Breaking) [`@langchain/core`](https://www.npmjs.com/package/@langchain/core) is now a peer dependency and requires explicit installation.
- Added support for [dynamic breakpoints](/langgraphjs/how-tos/dynamic_breakpoints/).
- Added support for [separate input and output schema](/langgraphjs/how-tos/input_output_schema/).
- Allow using an array to specify destination nodes from a conditional edge as shorthand for object.
- Numerous bugfixes.

### v0.1.0

- (Breaking) Changed checkpoint representations to support namespacing for subgraphs and pending writes.
- (Breaking) `MessagesState` was changed to [`MessagesAnnotation`](/langgraphjs/reference/variables/langgraph.MessagesAnnotation.html).
- Added [`Annotation`](/langgraphjs/reference/modules/langgraph.Annotation.html), a more streamlined way to declare state. Removes the need for separate type and channel declarations.
- Split checkpointer implementations into different libraries for easier inheritance.
- Major internal architecture refactor to use more robust patterns.
- Deprecated `MessageGraph` in favor of [`StateGraph`](/langgraphjs/reference/classes/langgraph.StateGraph.html) + [`MessagesAnnotation`](/langgraphjs/reference/variables/langgraph.MessagesAnnotation.html).
- Numerous bugfixes.

## Upgrading

When upgrading LangGraph.js, please refer to the specific version sections below for detailed instructions on how to adapt your code to the latest changes.

### Upgrading to v0.3.0

- If a node is interrupted, it will now be present in the `"values"` stream mode and in `.invoke()` under the `__interrupts` key. You can use the `isInterrupted()` method to check if the state contains an interrupt and handle it appropriately.
- The return type of `.stream()` is no longer `IterableReadableStream<any>`, which means you may need to fix any type errors.

### Upgrading to v0.2.0

- You will now need to install `@langchain/core` explicitly. See [this page](https://langchain-ai.github.io/langgraphjs/how-tos/manage-ecosystem-dependencies/) for more information.

### Upgrading to v0.1.0

- Old saved checkpoints will no longer be valid, and you will need to update to use a new prebuilt checkpointer.
- We recommend switching to the new `Annotation` syntax when declaring graph state.

## Deprecation Notices

This section will list any deprecated features or APIs, along with their planned removal dates and recommended alternatives.

#### `MessageGraph`

Use [`MessagesAnnotation`](/langgraphjs/reference/variables/langgraph.MessagesAnnotation.html) with [`StateGraph`](/langgraphjs/reference/classes/langgraph.StateGraph.html).

#### `createFunctionCallingExecutor`

Use [`createReactAgent`](/langgraphjs/reference/functions/langgraph_prebuilt.createReactAgent.html) with a model that supports tool calling.

#### `ToolExecutor`

Use [`ToolNode`](/langgraphjs/reference/classes/langgraph_prebuilt.ToolNode.html) instead.

## Full changelog

For the most up-to-date information on LangGraph.js versions and changes, please refer to our [GitHub repository](https://github.com/langchain-ai/langgraphjs) and [release notes](https://github.com/langchain-ai/langgraphjs/releases).
