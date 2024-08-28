# Low Level Conceptual Guide

## Graphs

At its core, LangGraph models agent workflows as graphs. You define the behavior of your agents using three key components:

1. [`State`](#state): A shared data structure that represents the current snapshot of your application. It is represented by an [`annotations`](/langgraphjs/reference/functions/langgraph.Annotation-1.html) object.

2. [`Nodes`](#nodes): JavaScript/TypeScript functions that encode the logic of your agents. They receive the current `State` as input, perform some computation or side-effect, and return an updated `State`.

3. [`Edges`](#edges): JavaScript/TypeScript functions that determine which `Node` to execute next based on the current `State`. They can be conditional branches or fixed transitions.

By composing `Nodes` and `Edges`, you can create complex, looping workflows that evolve the `State` over time. The real power, though, comes from how LangGraph manages that `State`. To emphasize: `Nodes` and `Edges` are nothing more than JavaScript/TypeScript functions - they can contain an LLM or just good ol' JavaScript/TypeScript code.

In short: _nodes do the work. edges tell what to do next_.

LangGraph's underlying graph algorithm uses [message passing](https://en.wikipedia.org/wiki/Message_passing) to define a general program. When a Node completes its operation, it sends messages along one or more edges to other node(s). These recipient nodes then execute their functions, pass the resulting messages to the next set of nodes, and the process continues. Inspired by Google's [Pregel](https://research.google/pubs/pregel-a-system-for-large-scale-graph-processing/) system, the program proceeds in discrete "super-steps."

A super-step can be considered a single iteration over the graph nodes. Nodes that run in parallel are part of the same super-step, while nodes that run sequentially belong to separate super-steps. At the start of graph execution, all nodes begin in an `inactive` state. A node becomes `active` when it receives a new message (state) on any of its incoming edges (or "channels"). The active node then runs its function and responds with updates. At the end of each super-step, nodes with no incoming messages vote to `halt` by marking themselves as `inactive`. The graph execution terminates when all nodes are `inactive` and no messages are in transit.

### StateGraph

The `StateGraph` class is the main graph class to uses. This is parameterized by a user defined `State` object. (defined using the `Annotation` object and passed as the first argument)

### MessageGraph

The `MessageGraph` class is a special type of graph. The `State` of a `MessageGraph` is ONLY an array of messages. This class is rarely used except for chatbots, as most applications require the `State` to be more complex than an array of messages.

### Compiling your graph

To build your graph, you first define the [state](#state), you then add [nodes](#nodes) and [edges](#edges), and then you compile it. What exactly is compiling your graph and why is it needed?

Compiling is a pretty simple step. It provides a few basic checks on the structure of your graph (no orphaned nodes, etc). It is also where you can specify runtime args like [checkpointers](#checkpointer) and [breakpoints](#breakpoints). You compile your graph by just calling the `.compile` method:

```typescript
const graph = graphBuilder.compile(...);
```

You **MUST** compile your graph before you can use it.

## State

The first thing you do when you define a graph is define the `State` of the graph. The `State` consists of the [schema of the graph](#schema) as well as [`reducer` functions](#reducers) which specify how to apply updates to the state. The schema of the `State` will be the input schema to all `Nodes` and `Edges` in the graph, and should be defined using an [`Annotation`](/langgraphjs/reference/functions/langgraph.Annotation-1.html) object. All `Nodes` will emit updates to the `State` which are then applied using the specified `reducer` function.

### Schema

The way to specify the schema of a graph is by defining an [`Annotation`](/langgraphjs/reference/functions/langgraph.Annotation-1.html) object, where each key is an item in the state.

### Reducers

Reducers are key to understanding how updates from nodes are applied to the `State`. Each key in the `State` has its own independent reducer function. If no reducer function is explicitly specified then it is assumed that all updates to that key should override it. Let's take a look at a few examples to understand them better.

**Example A:**

```typescript
import { StateGraph, Annotation } from "@langchain/langgraph";

const State = Annotation.Root({
  foo: Annotation<number>,
  bar: Annotation<string[]>,
})

const graphBuilder = new StateGraph(State);
```

In this example, no reducer functions are specified for any key. Let's assume the input to the graph is `{ foo: 1, bar: ["hi"] }`. Let's then assume the first `Node` returns `{ foo: 2 }`. This is treated as an update to the state. Notice that the `Node` does not need to return the whole `State` schema - just an update. After applying this update, the `State` would then be `{ foo: 2, bar: ["hi"] }`. If the second node returns `{ bar: ["bye"] }` then the `State` would then be `{ foo: 2, bar: ["bye"] }`

**Example B:**

```typescript
import { StateGraph, Annotation } from "@langchain/langgraph";

const State = Annotation.Root({
  foo: Annotation<number>,
  bar: Annotation<string[]>({
    reducer: (state: string[], update: string[]) => state.concat(update),
    default: () => [],
  }),
})

const graphBuilder = new StateGraph(State);
```

In this example, we've updated our `bar` field to be an object containing a `reducer` function. This function will always accept two positional arguments: `state` and `update`, with `state` representing the current state value, and `update` representing the update returned from a `Node`. Note that the first key remains unchanged. Let's assume the input to the graph is `{ foo: 1, bar: ["hi"] }`. Let's then assume the first `Node` returns `{ foo: 2 }`. This is treated as an update to the state. Notice that the `Node` does not need to return the whole `State` schema - just an update. After applying this update, the `State` would then be `{ foo: 2, bar: ["hi"] }`. If the second node returns`{ bar: ["bye"] }` then the `State` would then be `{ foo: 2, bar: ["hi", "bye"] }`. Notice here that the `bar` key is updated by concatenating the two arrays together.

### MessageState

`MessageState` is one of the few opinionated components in LangGraph. `MessageState` is a special state designed to make it easy to use an array of messages as a key in your state. Specifically, `MessageState` is defined as:

```typescript
import { BaseMessage } from "@langchain/core/messages";
import { Annotation, StateGraph, messagesStateReducer } from "@langchain/langgraph";

// This can be imported from @langchain/langgraph
export const MessagesAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

export class MessageGraph extends StateGraph {
  constructor() {
    super(MessagesAnnotation);
  }
}
```

What this is doing is creating a `State` with a single key `messages`. This is an array of `BaseMessage`s, with [`messagesStateReducer`](/langgraphjs/reference/functions/langgraph.messagesStateReducer.html) as a reducer. `messagesStateReducer` basically adds messages to the existing list (it also does some nice extra things, like convert from OpenAI message format to the standard LangChain message format, handle updates based on message IDs, etc).

We often see an array of messages being a key component of state, so this prebuilt state is intended to make it easy to use messages. Typically, there is more state to track than just messages, so we see people extend this state and add more fields, like:

```typescript
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

const StateWithDocuments = Annotation.Root({
  ...MessagesAnnotation.spec, // Spread in the messages state
  documents: Annotation<string[]>,
})
```

## Nodes

In LangGraph, nodes are typically JavaScript/TypeScript functions (sync or `async`) where the **first** positional argument is the [state](#state), and (optionally), the **second** positional argument is a "config", containing optional [configurable parameters](#configuration) (such as a `thread_id`).

Similar to `NetworkX`, you add these nodes to a graph using the [addNode](/langgraphjs/reference/classes/langgraph.StateGraph.html#addNode) method:

```typescript
import { RunnableConfig } from "@langchain/core/runnables";
import { StateGraph, Annotation } from "@langchain/langgraph";

const GraphAnnotation = Annotation.Root({
  input: Annotation<string>,
  results: Annotation<string>,
})

// The state type can be extracted using `typeof <annotation variable name>.State`
const myNode = (state: typeof GraphAnnotation.State, config?: RunnableConfig) => {
  console.log("In node: ", config.configurable?.user_id);
  return {
    results: `Hello, ${state.input}!`
  }  
}

// The second argument is optional
const myOtherNode = (state: typeof GraphAnnotation.State) => {
  return state
}

const builder = new StateGraph(GraphAnnotation)
  .addNode("myNode", myNode)
  .addNode("myOtherNode", myOtherNode)
  ...
```

Behind the scenes, functions are converted to [RunnableLambda's](https://v02.api.js.langchain.com/classes/langchain_core_runnables.RunnableLambda.html), which adds batch and streaming support to your function, along with native tracing and debugging.

### `START` Node

The `START` Node is a special node that represents the node sends user input to the graph. The main purpose for referencing this node is to determine which nodes should be called first.

```typescript
import { START } from "@langchain/langgraph";

graph.addEdge(START, "nodeA");
```

### `END` Node

The `END` Node is a special node that represents a terminal node. This node is referenced when you want to denote which edges have no actions after they are done.

```typescript
import { END } from "@langchain/langgraph";

graph.addEdge("nodeA", END);
```

## Edges

Edges define how the logic is routed and how the graph decides to stop. This is a big part of how your agents work and how different nodes communicate with each other. There are a few key types of edges:

- Normal Edges: Go directly from one node to the next.
- Conditional Edges: Call a function to determine which node(s) to go to next.
- Entry Point: Which node to call first when user input arrives.
- Conditional Entry Point: Call a function to determine which node(s) to call first when user input arrives.

A node can have MULTIPLE outgoing edges. If a node has multiple out-going edges, **all** of those destination nodes will be executed in parallel as a part of the next superstep.

### Normal Edges

If you **always** want to go from node A to node B, you can use the [addEdge](/langgraphjs/reference/classes/langgraph.StateGraph.html#addEdge) method directly.

```typescript
graph.addEdge("nodeA", "nodeB");
```

### Conditional Edges

If you want to **optionally** route to 1 or more edges (or optionally terminate), you can use the [addConditionalEdges](/langgraphjs/reference/classes/langgraph.StateGraph.html#addConditionalEdges) method. This method accepts the name of a node and a "routing function" to call after that node is executed:

```typescript
graph.addConditionalEdges("nodeA", routingFunction);
```

Similar to nodes, the `routingFunction` accept the current `state` of the graph and return a value.

By default, the return value `routingFunction` is used as the name of the node (or an array of nodes) to send the state to next. All those nodes will be run in parallel as a part of the next superstep.

You can optionally provide an object that maps the `routingFunction`'s output to the name of the next node.

```typescript
graph.addConditionalEdges("nodeA", routingFunction, {
  true: "nodeB",
  false: "nodeC"
});
```

### Entry Point

The entry point is the first node(s) that are run when the graph starts. You can use the [`addEdge`](/langgraphjs/reference/classes/langgraph.StateGraph.html#addEdge) method from the virtual [`START`](/langgraphjs/reference/variables/langgraph.START.html) node to the first node to execute to specify where to enter the graph.

```typescript
import { START } from "@langchain/langgraph" 

graph.addEdge(START, "nodeA")
```

### Conditional Entry Point

A conditional entry point lets you start at different nodes depending on custom logic. You can use [`addConditionalEdges`](/langgraphjs/reference/classes/langgraph.StateGraph.html#addConditionalEdges) from the virtual [`START`](/langgraphjs/reference/variables/langgraph.START.html) node to accomplish this.

```typescript
import { START } from "@langchain/langgraph" 

graph.addConditionalEdges(START, routingFunction)
```

You can optionally provide an object that maps the `routingFunction`'s output to the name of the next node.

```typescript
graph.addConditionalEdges(START, routingFunction, {
  true: "nodeB",
  false: "nodeC"
});
```

## `Send`

By default, `Nodes` and `Edges` are defined ahead of time and operate on the same shared state. However, there can be cases where the exact edges are not known ahead of time and/or you may want different versions of `State` to exist at the same time. A common of example of this is with `map-reduce` design patterns. In this design pattern, a first node may generate an array of objects, and you may want to apply some other node to all those objects. The number of objects may be unknown ahead of time (meaning the number of edges may not be known) and the input `State` to the downstream `Node` should be different (one for each generated object).

To support this design pattern, LangGraph supports returning [`Send`](/langgraphjs/reference/classes/langgraph.Send.html) objects from conditional edges. `Send` takes two arguments: first is the name of the node, and second is the state to pass to that node.

```typescript
const continueToJokes = (state: { subjects: string[] }) => {
  return state.subjects.map((subject) => new Send("generate_joke", { subject }));
}

graph.addConditionalEdges("nodeA", continueToJokes);
```

## Checkpointer

LangGraph has a built-in persistence layer, implemented through [checkpointers](/langgraphjs/reference/classes/checkpoint.BaseCheckpointSaver.html). When you use a checkpointer with a graph, you can interact with the state of that graph. When you use a checkpointer with a graph, you can interact with and manage the graph's state. The checkpointer saves a _checkpoint_ of the graph state at every super-step, enabling several powerful capabilities:

First, checkpointers facilitate [human-in-the-loop workflows](agentic_concepts.md#human-in-the-loop) workflows by allowing humans to inspect, interrupt, and approve steps. Checkpointers are needed for these workflows as the human has to be able to view the state of a graph at any point in time, and the graph has to be to resume execution after the human has made any updates to the state.

Second, it allows for ["memory"](agentic_concepts.md#memory) between interactions. You can use checkpointers to create threads and save the state of a thread after a graph executes. In the case of repeated human interactions (like conversations) any follow up messages can be sent to that checkpoint, which will retain its memory of previous ones.

See [this guide](../how-tos/persistence.ipynb) for how to add a checkpointer to your graph.

## Threads

Threads enable the checkpointing of multiple different runs, making them essential for multi-tenant chat applications and other scenarios where maintaining separate states is necessary. A thread is a unique ID assigned to a series of checkpoints saved by a checkpointer. When using a checkpointer, you must specify a `thread_id` when running the graph.

`thread_id` is simply the ID of a thread. This is always required

You must pass these when invoking the graph as part of the configurable part of the config.

```typescript
const config = { configurable: { thread_id: "a" }};
await graph.invoke(inputs, config);
```

See [this guide](../how-tos/persistence.ipynb) for how to use threads.

## Checkpointer state

When interacting with the checkpointer state, you must specify a [thread identifier](#threads). Each checkpoint saved by the checkpointer has two properties:

- **values**: This is the value of the state at this point in time.
- **next**: This is a tuple of the nodes to execute next in the graph.

### Get state

You can get the state of a checkpointer by calling `await graph.getState(config)`. The config should contain `thread_id`, and the state will be fetched for that thread.

### Get state history

You can also call `await graph.getStateHistory(config)` to get a list of the history of the graph. The config should contain `thread_id`, and the state history will be fetched for that thread.

### Update state

You can also interact with the state directly and update it. This takes three different components:

- `config`
- `values`
- `asNode`

**config**

The config should contain `thread_id` specifying which thread to update.

**values**

These are the values that will be used to update the state. Note that this update is treated exactly as any update from a node is treated. This means that these values will be passed to the [reducer](#reducers) functions that are part of the state. So this does NOT automatically overwrite the state. Let's walk through an example.

Let's assume you have defined the state of your graph as:

```typescript
const GraphAnnotation = Annotation.Root({
  foo: Annotation<number>,
  bar: Annotation<string[]>({
    reducer: (state, update) => state.concat(update),
    default: () => [],
  }),
})
```

Let's now assume the current state of the graph is

```
{ foo: 1, bar: ["a"] }
```

If you update the state as below:

```typescript
await graph.updateState(config, { foo: 2, bar: ["b"] })
```

Then the new state of the graph will be:

```
{ foo: 2, bar: ["a", "b] }
```

The `foo` key is completely changed (because there is no reducer specified for that key, so it overwrites it). However, there is a reducer specified for the `bar` key, and so it appends `"b"` to the state of `bar`.

**`asNode`**

The final thing you specify when calling `updateState` is `asNode`. This update will be applied as if it came from node `asNode`. If `asNode` is not provided, it will be set to the last node that updated the state, if not ambiguous.

The reason this matters is that the next steps in the graph to execute depend on the last node to have given an update, so this can be used to control which node executes next.

## Configuration

When creating a graph, you can also mark that certain parts of the graph are configurable. This is commonly done to enable easily switching between models or system prompts. This allows you to create a single "cognitive architecture" (the graph) but have multiple different instance of it.

You can then pass this configuration into the graph using the `configurable` config field.

```typescript
const config = { configurable: { llm: "anthropic" }};

await graph.invoke(inputs, config);
```

You can then access and use this configuration inside a node:

```typescript
const nodeA = (state, config) => {
  const llmType = config?.configurable?.llm;
  let llm: BaseChatModel;
  if (llmType) {
    const llm = getLlm(llmType);
  }
  ...
};
    
```

See [this guide](../how-tos/configuration.ipynb) for a full breakdown on configuration

## Breakpoints

It can often be useful to set breakpoints before or after certain nodes execute. This can be used to wait for human approval before continuing. These can be set when you ["compile" a graph](#compiling-your-graph). You can set breakpoints either _before_ a node executes (using `interruptBefore`) or after a node executes (using `interruptAfter`.)

You **MUST** use a [checkpoiner](#checkpointer) when using breakpoints. This is because your graph needs to be able to resume execution.

In order to resume execution, you can just invoke your graph with `null` as the input.

```typescript
// Initial run of graph
await graph.invoke(inputs, config);

// Let's assume it hit a breakpoint somewhere, you can then resume by passing in None
await graph.invoke(null, config);
```

See [this guide](../how-tos/breakpoints.ipynb) for a full walkthrough of how to add breakpoints.

## Visualization

It's often nice to be able to visualize graphs, especially as they get more complex. LangGraph comes with several built-in ways to visualize graphs.

## Streaming

LangGraph is built with first class support for streaming. There are several different streaming modes that LangGraph supports:

- [`"values"`](../how-tos/stream-values.ipynb): This streams the full value of the state after each step of the graph.
- [`"updates`](../how-tos/stream-updates.ipynb): This streams the updates to the state after each step of the graph. If multiple updates are made in the same step (e.g. multiple nodes are run) then those updates are streamed separately.

In addition, you can use the [`streamEvents`](https://v02.api.js.langchain.com/classes/langchain_core_runnables.Runnable.html#streamEvents) method to stream back events that happen _inside_ nodes. This is useful for [streaming tokens of LLM calls](../how-tos/streaming-tokens-without-langchain.ipynb).
