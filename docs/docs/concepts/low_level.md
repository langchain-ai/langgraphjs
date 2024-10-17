# LangGraph Glossary

## Graphs

At its core, LangGraph models agent workflows as graphs. You define the behavior of your agents using three key components:

1. [`State`](#state): A shared data structure that represents the current snapshot of your application. It is represented by an [`Annotation`](/langgraphjs/reference/modules/langgraph.Annotation.html) object.

2. [`Nodes`](#nodes): JavaScript/TypeScript functions that encode the logic of your agents. They receive the current `State` as input, perform some computation or side-effect, and return an updated `State`.

3. [`Edges`](#edges): JavaScript/TypeScript functions that determine which `Node` to execute next based on the current `State`. They can be conditional branches or fixed transitions.

By composing `Nodes` and `Edges`, you can create complex, looping workflows that evolve the `State` over time. The real power, though, comes from how LangGraph manages that `State`. To emphasize: `Nodes` and `Edges` are nothing more than JavaScript/TypeScript functions - they can contain an LLM or just good ol' JavaScript/TypeScript code.

In short: _nodes do the work. edges tell what to do next_.

LangGraph's underlying graph algorithm uses [message passing](https://en.wikipedia.org/wiki/Message_passing) to define a general program. When a Node completes its operation, it sends messages along one or more edges to other node(s). These recipient nodes then execute their functions, pass the resulting messages to the next set of nodes, and the process continues. Inspired by Google's [Pregel](https://research.google/pubs/pregel-a-system-for-large-scale-graph-processing/) system, the program proceeds in discrete "super-steps."

A super-step can be considered a single iteration over the graph nodes. Nodes that run in parallel are part of the same super-step, while nodes that run sequentially belong to separate super-steps. At the start of graph execution, all nodes begin in an `inactive` state. A node becomes `active` when it receives a new message (state) on any of its incoming edges (or "channels"). The active node then runs its function and responds with updates. At the end of each super-step, nodes with no incoming messages vote to `halt` by marking themselves as `inactive`. The graph execution terminates when all nodes are `inactive` and no messages are in transit.

### StateGraph

The `StateGraph` class is the main graph class to use. This is parameterized by a user defined `State` object. (defined using the `Annotation` object and passed as the first argument)

### MessageGraph (legacy) {#messagegraph}

The `MessageGraph` class is a special type of graph. The `State` of a `MessageGraph` is ONLY an array of messages. This class is rarely used except for chatbots, as most applications require the `State` to be more complex than an array of messages.

### Compiling your graph

To build your graph, you first define the [state](#state), you then add [nodes](#nodes) and [edges](#edges), and then you compile it. What exactly is compiling your graph and why is it needed?

Compiling is a pretty simple step. It provides a few basic checks on the structure of your graph (no orphaned nodes, etc). It is also where you can specify runtime args like [checkpointers](#checkpointer) and [breakpoints](#breakpoints). You compile your graph by just calling the `.compile` method:

```typescript
const graph = graphBuilder.compile(...);
```

You **MUST** compile your graph before you can use it.

## State

The first thing you do when you define a graph is define the `State` of the graph. The `State` includes information on the structure of the graph, as well as [`reducer` functions](#reducers) which specify how to apply updates to the state. The schema of the `State` will be the input schema to all `Nodes` and `Edges` in the graph, and should be defined using an [`Annotation`](/langgraphjs/reference/modules/langgraph.Annotation.html) object. All `Nodes` will emit updates to the `State` which are then applied using the specified `reducer` function.

### Annotation

The way to specify the schema of a graph is by defining a root [`Annotation`](/langgraphjs/reference/modules/langgraph.Annotation.html) object, where each key is an item in the state.

#### Multiple schemas

Typically, all graph nodes communicate with a single state annotation. This means that they will read and write to the same state channels. But, there are cases where we want more control over this:

- Internal nodes can pass information that is not required in the graph's input / output.
- We may also want to use different input / output schemas for the graph. The output might, for example, only contain a single relevant output key.

It is possible to have nodes write to private state channels inside the graph for internal node communication. We can simply define a private annotation, `PrivateState`. See [this notebook](../how-tos/pass_private_state.ipynb) for more detail.

It is also possible to define explicit input and output schemas for a graph. In these cases, we define an "internal" schema that contains _all_ keys relevant to graph operations. But, we also define `input` and `output` schemas that are sub-sets of the "internal" schema to constrain the input and output of the graph. See [this guide](../how-tos/input_output_schema.ipynb) for more detail.

Let's look at an example:

```ts
import { Annotation, StateGraph } from "@langchain/langgraph";

const InputStateAnnotation = Annotation.Root({
  user_input: Annotation<string>,
});

const OutputStateAnnotation = Annotation.Root({
  graph_output: Annotation<string>,
});

const OverallStateAnnotation = Annotation.Root({
  foo: Annotation<string>,
  bar: Annotation<string>,
  user_input: Annotation<string>,
  graph_output: Annotation<string>,
});

const node1 = async (state: typeof InputStateAnnotation.State) => {
  // Write to OverallStateAnnotation
  return { foo: state.user_input + " name" };
};

const node2 = async (state: typeof OverallStateAnnotation.State) => {
  // Read from OverallStateAnnotation, write to OverallStateAnnotation
  return { bar: state.foo + " is" };
};

const node3 = async (state: typeof OverallStateAnnotation.State) => {
  // Read from OverallStateAnnotation, write to OutputStateAnnotation
  return { graph_output: state.bar + " Lance" };
};

const graph = new StateGraph({
  input: InputStateAnnotation,
  output: OutputStateAnnotation,
  stateSchema: OverallStateAnnotation,
})
  .addNode("node1", node1)
  .addNode("node2", node2)
  .addNode("node3", node3)
  .addEdge("__start__", "node1")
  .addEdge("node1", "node2")
  .addEdge("node2", "node3")
  .compile();

await graph.invoke({ user_input: "My" });
```

```
{ graph_output: "My name is Lance" }
```

Note that we pass `state: typeof InputStateAnnotation.State` as the input schema to `node1`. But, we write out to `foo`, a channel in `OverallStateAnnotation`. How can we write out to a state channel that is not included in the input schema? This is because a node _can write to any state channel in the graph state._ The graph state is the union of of the state channels defined at initialization, which includes `OverallStateAnnotation` and the filters `InputStateAnnotation` and `OutputStateAnnotation`.

### Reducers

Reducers are key to understanding how updates from nodes are applied to the `State`. Each key in the `State` has its own independent reducer function. If no reducer function is explicitly specified then it is assumed that all updates to that key should override it. Let's take a look at a few examples to understand them better.

**Example A:**

```typescript
import { StateGraph, Annotation } from "@langchain/langgraph";

const State = Annotation.Root({
  foo: Annotation<number>,
  bar: Annotation<string[]>,
});

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
});

const graphBuilder = new StateGraph(State);
```

In this example, we've updated our `bar` field to be an object containing a `reducer` function. This function will always accept two positional arguments: `state` and `update`, with `state` representing the current state value, and `update` representing the update returned from a `Node`. Note that the first key remains unchanged. Let's assume the input to the graph is `{ foo: 1, bar: ["hi"] }`. Let's then assume the first `Node` returns `{ foo: 2 }`. This is treated as an update to the state. Notice that the `Node` does not need to return the whole `State` schema - just an update. After applying this update, the `State` would then be `{ foo: 2, bar: ["hi"] }`. If the second node returns`{ bar: ["bye"] }` then the `State` would then be `{ foo: 2, bar: ["hi", "bye"] }`. Notice here that the `bar` key is updated by concatenating the two arrays together.

### Working with Messages in Graph State

#### Why use messages?

Most modern LLM providers have a chat model interface that accepts a list of messages as input. LangChain's [`ChatModel`](https://js.langchain.com/docs/concepts/#chat-models) in particular accepts a list of `Message` objects as inputs. These messages come in a variety of forms such as `HumanMessage` (user input) or `AIMessage` (LLM response). To read more about what message objects are, please refer to [this](https://js.langchain.com/docs/concepts/#message-types) conceptual guide.

#### Using Messages in your Graph

In many cases, it is helpful to store prior conversation history as a list of messages in your graph state. To do so, we can add a key (channel) to the graph state that stores a list of `Message` objects and annotate it with a reducer function (see `messages` key in the example below). The reducer function is vital to telling the graph how to update the list of `Message` objects in the state with each state update (for example, when a node sends an update). If you don't specify a reducer, every state update will overwrite the list of messages with the most recently provided value.

However, you might also want to manually update messages in your graph state (e.g. human-in-the-loop). If you were to use something like `(a, b) => a.concat(b)` as a reducer, the manual state updates you send to the graph would be appended to the existing list of messages, instead of updating existing messages. To avoid that, you need a reducer that can keep track of message IDs and overwrite existing messages, if updated. To achieve this, you can use the prebuilt `messagesStateReducer` function. For brand new messages, it will simply append to existing list, but it will also handle the updates for existing messages correctly.

#### Serialization

In addition to keeping track of message IDs, the `messagesStateReducer` function will also try to deserialize messages into LangChain `Message` objects whenever a state update is received on the `messages` channel. This allows sending graph inputs / state updates in the following format:

```ts
// this is supported
{
  messages: [new HumanMessage({ content: "message" })];
}

// and this is also supported
{
  messages: [{ role: "user", content: "message" }];
}
```

Below is an example of a graph state annotation that uses `messagesStateReducer` as it's reducer function.

```ts
import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, type Messages } from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer,
  }),
});
```

#### MessagesAnnotation

Since having a list of messages in your state is so common, there exists a prebuilt annotation called `MessagesAnnotation` which makes it easy to use messages as graph state. `MessagesAnnotation` is defined with a single `messages` key which is a list of `BaseMessage` objects and uses the `messagesStateReducer` reducer.

```typescript
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

const graph = new StateGraph(MessagesAnnotation)
  .addNode(...)
  ...
```

Is equivalent to initializing your state manually like this:

```typescript
import { BaseMessage } from "@langchain/core/messages";
import { Annotation, StateGraph, messagesStateReducer } from "@langchain/langgraph";

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

const graph = new StateGraph(StateAnnotation)
  .addNode(...)
  ...
```

The state of a `MessagesAnnotation` has a single key called `messages`. This is an array of `BaseMessage`s, with [`messagesStateReducer`](/langgraphjs/reference/functions/langgraph.messagesStateReducer.html) as a reducer. `messagesStateReducer` basically adds messages to the existing list (it also does some nice extra things, like convert from OpenAI message format to the standard LangChain message format, handle updates based on message IDs, etc).

We often see an array of messages being a key component of state, so this prebuilt state is intended to make it easy to use messages. Typically, there is more state to track than just messages, so we see people extend this state and add more fields, like:

```typescript
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

const StateWithDocuments = Annotation.Root({
  ...MessagesAnnotation.spec, // Spread in the messages state
  documents: Annotation<string[]>,
});
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
  false: "nodeC",
});
```

### Entry Point

The entry point is the first node(s) that are run when the graph starts. You can use the [`addEdge`](/langgraphjs/reference/classes/langgraph.StateGraph.html#addEdge) method from the virtual [`START`](/langgraphjs/reference/variables/langgraph.START.html) node to the first node to execute to specify where to enter the graph.

```typescript
import { START } from "@langchain/langgraph";

graph.addEdge(START, "nodeA");
```

### Conditional Entry Point

A conditional entry point lets you start at different nodes depending on custom logic. You can use [`addConditionalEdges`](/langgraphjs/reference/classes/langgraph.StateGraph.html#addConditionalEdges) from the virtual [`START`](/langgraphjs/reference/variables/langgraph.START.html) node to accomplish this.

```typescript
import { START } from "@langchain/langgraph";

graph.addConditionalEdges(START, routingFunction);
```

You can optionally provide an object that maps the `routingFunction`'s output to the name of the next node.

```typescript
graph.addConditionalEdges(START, routingFunction, {
  true: "nodeB",
  false: "nodeC",
});
```

## `Send`

By default, `Nodes` and `Edges` are defined ahead of time and operate on the same shared state. However, there can be cases where the exact edges are not known ahead of time and/or you may want different versions of `State` to exist at the same time. A common of example of this is with `map-reduce` design patterns. In this design pattern, a first node may generate an array of objects, and you may want to apply some other node to all those objects. The number of objects may be unknown ahead of time (meaning the number of edges may not be known) and the input `State` to the downstream `Node` should be different (one for each generated object).

To support this design pattern, LangGraph supports returning [`Send`](/langgraphjs/reference/classes/langgraph.Send.html) objects from conditional edges. `Send` takes two arguments: first is the name of the node, and second is the state to pass to that node.

```typescript
const continueToJokes = (state: { subjects: string[] }) => {
  return state.subjects.map(
    (subject) => new Send("generate_joke", { subject })
  );
};

graph.addConditionalEdges("nodeA", continueToJokes);
```

## Persistence

LangGraph provides built-in persistence for your agent's state using [checkpointers](/langgraphjs/reference/classes/checkpoint.BaseCheckpointSaver.html). Checkpointers save snapshots of the graph state at every superstep, allowing resumption at any time. This enables features like human-in-the-loop interactions, memory management, and fault-tolerance. You can even directly manipulate a graph's state after its execution using the appropriate `get` and `update` methods. For more details, see the [conceptual guide](/langgraphjs/concepts/persistence) for more information.

## Threads

Threads in LangGraph represent individual sessions or conversations between your graph and a user. When using checkpointing, turns in a single conversation (and even steps within a single graph execution) are organized by a unique thread ID.

## Storage

LangGraph provides built-in document storage through the [BaseStore](/langgraphjs/reference/classes/store.BaseStore.html) interface. Unlike checkpointers, which save state by thread ID, stores use custom namespaces for organizing data. This enables cross-thread persistence, allowing agents to maintain long-term memories, learn from past interactions, and accumulate knowledge over time. Common use cases include storing user profiles, building knowledge bases, and managing global preferences across all threads.

## Graph Migrations

LangGraph can easily handle migrations of graph definitions (nodes, edges, and state) even when using a checkpointer to track state.

- For threads at the end of the graph (i.e. not interrupted) you can change the entire topology of the graph (i.e. all nodes and edges, remove, add, rename, etc)
- For threads currently interrupted, we support all topology changes other than renaming / removing nodes (as that thread could now be about to enter a node that no longer exists) -- if this is a blocker please reach out and we can prioritize a solution.
- For modifying state, we have full backwards and forwards compatibility for adding and removing keys
- State keys that are renamed lose their saved state in existing threads
- State keys whose types change in incompatible ways could currently cause issues in threads with state from before the change -- if this is a blocker please reach out and we can prioritize a solution.

## Configuration

When creating a graph, you can also mark that certain parts of the graph are configurable. This is commonly done to enable easily switching between models or system prompts. This allows you to create a single "cognitive architecture" (the graph) but have multiple different instance of it.

You can then pass this configuration into the graph using the `configurable` config field.

```typescript
const config = { configurable: { llm: "anthropic" } };

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

It can often be useful to set breakpoints before or after certain nodes execute. This can be used to wait for human approval before continuing. These can be set when you ["compile" a graph](#compiling-your-graph), or thrown dynamically using a special error called a [`NodeInterrupt`](../how-tos/dynamic_breakpoints.ipynb). You can set breakpoints either _before_ a node executes (using `interruptBefore`) or after a node executes (using `interruptAfter`).

You **MUST** use a [checkpoiner](#checkpointer) when using breakpoints. This is because your graph needs to be able to resume execution.

In order to resume execution, you can just invoke your graph with `null` as the input and the same `thread_id`.

```typescript
const config = { configurable: { thread_id: "foo" } };

// Initial run of graph
await graph.invoke(inputs, config);

// Let's assume it hit a breakpoint somewhere, you can then resume by passing in None
await graph.invoke(null, config);
```

See [this guide](../how-tos/breakpoints.ipynb) for a full walkthrough of how to add breakpoints.

### Dynamic Breakpoints

It may be helpful to **dynamically** interrupt the graph from inside a given node based on some condition. In `LangGraph` you can do so by using `NodeInterrupt` -- a special error that can be raised from inside a node.

```typescript
function myNode(
  state: typeof GraphAnnotation.State
): typeof GraphAnnotation.State {
  if (state.input.length > 5) {
    throw new NodeInterrupt(
      `Received input that is longer than 5 characters: ${state.input}`
    );
  }

  return state;
}
```

## Subgraphs

A subgraph is a [graph](#graphs) that is used as a [node](#nodes) in another graph. This is nothing more than the age-old concept of encapsulation, applied to LangGraph. Some reasons for using subgraphs are:

- building [multi-agent systems](./multi_agent.md)
- when you want to reuse a set of nodes in multiple graphs, which maybe share some state, you can define them once in a subgraph and then use them in multiple parent graphs
- when you want different teams to work on different parts of the graph independently, you can define each part as a subgraph, and as long as the subgraph interface (the input and output schemas) is respected, the parent graph can be built without knowing any details of the subgraph

There are two ways to add subgraphs to a parent graph:

- add a node with the compiled subgraph: this is useful when the parent graph and the subgraph share state keys and you don't need to transform state on the way in or out

```ts
.addNode("subgraph", subgraphBuilder.compile());
```

- add a node with a function that invokes the subgraph: this is useful when the parent graph and the subgraph have different state schemas and you need to transform state before or after calling the subgraph

```ts
const subgraph = subgraphBuilder.compile();

const callSubgraph = async (state: typeof StateAnnotation.State) => {
  return subgraph.invoke({ subgraph_key: state.parent_key });
};

builder.addNode("subgraph", callSubgraph);
```

Let's take a look at examples for each.

### As a compiled graph

The simplest way to create subgraph nodes is by using a [compiled subgraph](#compiling-your-graph) directly. When doing so, it is **important** that the parent graph and the subgraph [state schemas](#state) share at least one key which they can use to communicate. If your graph and subgraph do not share any keys, you should use write a function [invoking the subgraph](#as-a-function) instead.

<div class="admonition note">
    <p class="admonition-title">Note</p>
    <p>
      If you pass extra keys to the subgraph node (i.e., in addition to the shared keys), they will be ignored by the subgraph node. Similarly, if you return extra keys from the subgraph, they will be ignored by the parent graph.
    </p>
</div>

```ts
import { StateGraph, Annotation } from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  foo: Annotation<string>,
});

const SubgraphStateAnnotation = Annotation.Root({
  foo: Annotation<string>, // note that this key is shared with the parent graph state
  bar: Annotation<string>,
});

// Define subgraph
const subgraphNode = async (state: typeof SubgraphStateAnnotation.State) => {
  // note that this subgraph node can communicate with
  // the parent graph via the shared "foo" key
  return { foo: state.foo + "bar" };
};

const subgraph = new StateGraph(SubgraphStateAnnotation)
  .addNode("subgraph", subgraphNode);
  ...
  .compile();

// Define parent graph
const parentGraph = new StateGraph(StateAnnotation)
  .addNode("subgraph", subgraph)
  ...
  .compile();
```

### As a function

You might want to define a subgraph with a completely different schema. In this case, you can create a node function that invokes the subgraph. This function will need to [transform](../how-tos/subgraph-transform-state.ipynb) the input (parent) state to the subgraph state before invoking the subgraph, and transform the results back to the parent state before returning the state update from the node.

```ts
import { StateGraph, Annotation } from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  foo: Annotation<string>,
});

const SubgraphStateAnnotation = Annotation.Root({
  // note that none of these keys are shared with the parent graph state
  bar: Annotation<string>,
  baz: Annotation<string>,
});

// Define subgraph
const subgraphNode = async (state: typeof SubgraphStateAnnotation.State) => {
  return { bar: state.bar + "baz" };
};

const subgraph = new StateGraph(SubgraphStateAnnotation)
  .addNode("subgraph", subgraphNode);
  ...
  .compile();

// Define parent graph
const subgraphWrapperNode = async (state: typeof StateAnnotation.State) => {
  // transform the state to the subgraph state
  const response = await subgraph.invoke({
    bar: state.foo,
  });
  // transform response back to the parent state
  return {
    foo: response.bar,
  };
}

const parentGraph = new StateGraph(StateAnnotation)
  .addNode("subgraph", subgraphWrapperNode)
  ...
  .compile();
```

## Visualization

It's often nice to be able to visualize graphs, especially as they get more complex. LangGraph comes with a nice built-in way to render a graph as a Mermaid diagram. You can use the `getGraph()` method like this:

```ts
const representation = graph.getGraph();
const image = await representation.drawMermaidPng();
const arrayBuffer = await image.arrayBuffer();
const buffer = new Uint8Array(arrayBuffer);
```

You can also check out [LangGraph Studio](https://github.com/langchain-ai/langgraph-studio) for a bespoke IDE that includes powerful visualization and debugging features.

## Streaming

LangGraph is built with first class support for streaming. There are several different streaming modes that LangGraph supports:

- [`"values"`](../how-tos/stream-values.ipynb): This streams the full value of the state after each step of the graph.
- [`"updates`](../how-tos/stream-updates.ipynb): This streams the updates to the state after each step of the graph. If multiple updates are made in the same step (e.g. multiple nodes are run) then those updates are streamed separately.

In addition, you can use the [`streamEvents`](https://api.js.langchain.com/classes/langchain_core_runnables.Runnable.html#streamEvents) method to stream back events that happen _inside_ nodes. This is useful for [streaming tokens of LLM calls](../how-tos/streaming-tokens-without-langchain.ipynb).

LangGraph is built with first class support for streaming, including streaming updates from graph nodes during execution, streaming tokens from LLM calls and more. See this [conceptual guide](./streaming.md) for more information.
