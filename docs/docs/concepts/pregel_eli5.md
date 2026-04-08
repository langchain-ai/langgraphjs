# Pregel in LangGraph, explained like you are 5

If you only remember one thing, remember this:

**Pregel is a game of passing notes between little workers.**

Each worker:

1. reads the notes it has,
2. does its tiny job,
3. writes new notes,
4. and then everybody waits until the round is over.

LangGraph uses this idea to run your graph step by step in a safe, organized way.

---

## The toy-box version

Imagine a classroom:

- **Nodes** are kids doing jobs.
- **Channels** are mailboxes.
- **State** is everything currently inside the mailboxes.
- A **superstep** is one classroom round:
  - all kids who have mail do their work,
  - they drop new mail into mailboxes,
  - then everyone waits,
  - then the next round starts.

That is the heart of Pregel.

```mermaid
flowchart LR
    Mailboxes[Mailboxes with notes]
    Kids[Kids who got notes]
    Work[They do their jobs]
    NewNotes[They write new notes]
    Wait[Everyone waits for round to finish]

    Mailboxes --> Kids --> Work --> NewNotes --> Wait --> Mailboxes
```

---

## What LangGraph adds on top

LangGraph lets you describe a workflow as a graph:

- "start here"
- "run this node"
- "then maybe go here"
- "save state"
- "pause for a human"
- "stream updates while running"

Under the hood, LangGraph turns that graph into a **Pregel engine run**.

So your nice, friendly graph API becomes:

- channels for state,
- tasks for runnable nodes,
- supersteps for execution,
- checkpoints for saving progress,
- interrupts for pausing,
- streams for live updates.

---

## The big picture in one picture

```mermaid
flowchart TD
    A[You build a StateGraph or Graph]
    B[compile]
    C[CompiledGraph / CompiledStateGraph]
    D[Compiled object is a Pregel engine]
    E[invoke or stream]
    F[PregelLoop plans rounds]
    G[PregelRunner runs ready tasks]
    H[Nodes write updates to channels]
    I[Writes applied together]
    J[Checkpoint / stream / maybe interrupt]
    K[Next round or done]

    A --> B --> C --> D --> E --> F --> G --> H --> I --> J --> K
```

---

## The 5 important characters

### 1) Nodes: the workers

A node is just a function that does some work.

In kid words:

- read the mailbox,
- think,
- put new notes back.

In LangGraph:

- nodes become **Pregel tasks**
- tasks run when their input channels changed

---

### 2) Channels: the mailboxes

Channels hold values and updates.

Different channels can behave differently:

- some keep the **last value**
- some **collect many values**
- some are just temporary for one step

This is why LangGraph state feels flexible: each state key is backed by a channel with rules for how updates are combined.

```mermaid
flowchart TB
    subgraph State["Graph state as channels"]
      C1[messages channel]
      C2[tools channel]
      C3[status channel]
    end

    N1[Node A reads messages]
    N2[Node B reads status]
    N3[Node C writes messages and status]

    C1 --> N1
    C3 --> N2
    N3 --> C1
    N3 --> C3
```

---

### 3) Supersteps: the rounds

Pregel does **not** run everything in a messy free-for-all.

It runs in rounds:

1. figure out which nodes are ready,
2. run them,
3. collect all their writes,
4. apply the writes together,
5. start the next round.

That "apply together" part is important.

It means LangGraph gets a clean rhythm:

- read old state for this round,
- do work,
- commit updates,
- move to next round.

```mermaid
flowchart LR
    A[Round starts]
    B[Pick ready nodes]
    C[Run them in parallel when possible]
    D[Collect writes]
    E[Apply writes to channels together]
    F[Save checkpoint and emit stream updates]
    G{More ready nodes?}

    A --> B --> C --> D --> E --> F --> G
    G -- yes --> A
    G -- no --> H[Done]
```

---

### 4) Checkpoints: the save button

A checkpoint is like saving your game.

LangGraph can save:

- current channel values,
- what changed,
- where the graph is,
- what should run next,
- enough information to resume later.

That is why LangGraph can support:

- persistence,
- resumability,
- time travel style debugging,
- human approval flows.

```mermaid
sequenceDiagram
    participant U as User
    participant G as Graph
    participant P as PregelLoop
    participant C as Checkpointer

    U->>G: invoke(input)
    G->>P: start run
    P->>P: finish one round
    P->>C: save checkpoint
    C-->>P: saved
    P->>P: continue or pause
```

---

### 5) Interrupts and streaming: pause and show

Pregel in LangGraph is not just "run until done."

It can also:

- **stream** values, updates, messages, debug events
- **interrupt** before or after certain nodes
- **resume** from saved state

So the engine is not just a runner. It is also a traffic cop and a save system.

---

## A tiny story example

Imagine this graph:

- `wakeUp`
- `brushTeeth`
- `packBag`
- `goToSchool`

And suppose:

- `wakeUp` triggers both `brushTeeth` and `packBag`
- then both must finish before `goToSchool`

Pregel naturally thinks in rounds:

```mermaid
flowchart TD
    S[START] --> W[wakeUp]
    W --> B[brushTeeth]
    W --> P[packBag]
    B --> G[goToSchool]
    P --> G
    G --> E[END]
```

Possible execution:

- **Round 1**: `wakeUp`
- **Round 2**: `brushTeeth` and `packBag` in parallel
- **Round 3**: `goToSchool`

That is a great example of how Pregel groups independent work into the same superstep.

---

## How LangGraph uses Pregel in the real code

Here is the real story in simple words.

### Step A: You build a graph

You write something like:

```ts
const graph = new StateGraph(...)
  .addNode(...)
  .addEdge(...)
  .compile();
```

At compile time, LangGraph turns your graph definition into a runnable object.

Important code path:

- `libs/langgraph-core/src/graph/state.ts`
- `libs/langgraph-core/src/graph/graph.ts`

### What compile does

Compile roughly does these things:

1. validates the graph,
2. creates channels for state keys and the `START` input,
3. creates Pregel nodes,
4. wires edges as triggers/subscriptions,
5. returns a compiled graph that **extends Pregel**.

That last part is the key:

**A compiled LangGraph graph is a Pregel engine.**

```mermaid
flowchart LR
    A[StateGraph definition]
    B[compile]
    C[channels created]
    D[nodes attached]
    E[edges attached]
    F[CompiledStateGraph]
    G[CompiledStateGraph extends CompiledGraph]
    H[CompiledGraph extends Pregel]

    A --> B --> C --> D --> E --> F --> G --> H
```

### Real code landmarks

- `StateGraph.compile(...)` builds `CompiledStateGraph`
- `CompiledStateGraph` extends `CompiledGraph`
- `CompiledGraph` extends `Pregel`

You can see this in:

- `libs/langgraph-core/src/graph/state.ts`
- `libs/langgraph-core/src/graph/graph.ts`

---

### Step B: You call `invoke()` or `stream()`

When you run the graph, LangGraph enters Pregel execution.

Important code path:

- `libs/langgraph-core/src/pregel/index.ts`

The main flow is approximately:

1. validate input and config,
2. create the output stream,
3. initialize the loop,
4. create the runner,
5. keep ticking until done.

```mermaid
sequenceDiagram
    participant U as User
    participant CG as CompiledGraph
    participant PR as Pregel._streamIterator
    participant PL as PregelLoop
    participant RU as PregelRunner

    U->>CG: invoke(input) or stream(input)
    CG->>PR: enter Pregel runtime
    PR->>PL: initialize
    PR->>RU: create runner
    loop each round
        PR->>PL: tick()
        PL-->>PR: ready tasks
        PR->>RU: tick()
        RU->>RU: run tasks
        RU-->>PL: writes collected
    end
    PR-->>U: final value or stream chunks
```

---

### Step C: PregelLoop plans the rounds

`PregelLoop` is the part that decides:

- "Is this the first step?"
- "Did we finish a round?"
- "Which tasks are ready next?"
- "Should we checkpoint?"
- "Should we interrupt?"
- "Are we done?"

Important file:

- `libs/langgraph-core/src/pregel/loop.ts`

### The important rhythm inside `tick()`

The loop does something like this:

1. if this is the first time, put the input into channels
2. if all current tasks finished, apply their writes
3. emit outputs/updates
4. save checkpoint
5. maybe interrupt
6. prepare next tasks
7. if no tasks remain, finish

That is the superstep heartbeat.

```mermaid
flowchart TD
    T0[tick begins]
    T1{First input?}
    T2[Map input into channels]
    T3{Previous round finished?}
    T4[Apply writes to channels]
    T5[Emit values or updates]
    T6[Save checkpoint]
    T7{Interrupt after?}
    T8[Prepare next tasks]
    T9{Interrupt before?}
    T10{Any tasks left?}
    T11[Return tasks for runner]
    T12[Done]

    T0 --> T1
    T1 -- yes --> T2 --> T8
    T1 -- no --> T3
    T3 -- yes --> T4 --> T5 --> T6 --> T7
    T3 -- no --> T8
    T7 -- yes --> T12
    T7 -- no --> T8 --> T9
    T9 -- yes --> T12
    T9 -- no --> T10
    T10 -- yes --> T11
    T10 -- no --> T12
```

---

### Step D: PregelRunner runs the ready tasks

`PregelRunner` is the muscle.

If `PregelLoop` is the teacher deciding who should work this round, `PregelRunner` is the part that actually says:

- "okay, ready kids, go"

Important file:

- `libs/langgraph-core/src/pregel/runner.ts`

It handles:

- running ready tasks,
- concurrency,
- retries,
- timeouts,
- abort signals,
- error collection,
- graph interrupts bubbling up correctly.

So:

- **Loop = planner**
- **Runner = executor**

```mermaid
flowchart LR
    A[PregelLoop picks ready tasks]
    B[PregelRunner executes tasks]
    C[Task writes collected]
    D[PregelLoop applies writes next]

    A --> B --> C --> D
```

---

### Step E: writes become state changes

When a node returns something, LangGraph does not instantly scramble the whole graph.

Instead, the node's result becomes **writes** to channels.

Then the loop applies those writes together at the end of the round.

Important files:

- `libs/langgraph-core/src/pregel/write.ts`
- `libs/langgraph-core/src/pregel/algo.ts`
- `libs/langgraph-core/src/pregel/io.ts`

This gives a stable pattern:

- nodes read from channels,
- nodes produce writes,
- writes update channels,
- channel updates decide who runs next.

```mermaid
flowchart LR
    A[Node reads channels]
    B[Node returns update]
    C[Update becomes channel writes]
    D[Writes applied to channels]
    E[Changed channels wake next nodes]

    A --> B --> C --> D --> E
```

---

## Why this design is nice

Pregel gives LangGraph a strong backbone:

### 1) Parallelism is natural

If two nodes are both ready in the same round, they can run together.

### 2) State updates are controlled

Updates are grouped by round, which makes behavior easier to reason about.

### 3) Persistence fits naturally

At the end of a round, it is a good time to save a checkpoint.

### 4) Interrupts fit naturally

You can pause before or after a round or certain nodes.

### 5) Streaming fits naturally

Each round can emit values, updates, messages, debug info, and more.

---

## The shortest accurate summary

LangGraph uses Pregel like this:

1. **Graph authoring layer**: you define nodes, edges, and state.
2. **Compile layer**: LangGraph turns that into channels + Pregel nodes.
3. **Runtime layer**: PregelLoop and PregelRunner execute the graph in supersteps.
4. **Persistence/interrupt/streaming layer**: checkpoints, pauses, resumes, and live output are added around that execution cycle.

---

## The "real names" behind the simple story

If you want to connect the kid story to the source code:

| Kid story | LangGraph name | Main file |
|---|---|---|
| workers | `PregelNode` / executable tasks | `libs/langgraph-core/src/pregel/read.ts` |
| mailboxes | channels | `libs/langgraph-core/src/channels/*` |
| round manager | `PregelLoop` | `libs/langgraph-core/src/pregel/loop.ts` |
| task runner | `PregelRunner` | `libs/langgraph-core/src/pregel/runner.ts` |
| decide next workers | `_prepareNextTasks` | `libs/langgraph-core/src/pregel/algo.ts` |
| apply all notes | `_applyWrites` | `libs/langgraph-core/src/pregel/algo.ts` |
| graph runtime | `Pregel` | `libs/langgraph-core/src/pregel/index.ts` |
| graph becomes pregel | `CompiledGraph extends Pregel` | `libs/langgraph-core/src/graph/graph.ts` |
| state graph compile | `StateGraph.compile` | `libs/langgraph-core/src/graph/state.ts` |

---

## One very practical mental model

When you run a LangGraph graph, imagine this:

```text
Round starts
-> which nodes got new mail?
-> run those nodes
-> collect all writes
-> update the mailboxes
-> save progress
-> tell the outside world what happened
-> repeat until nobody has work left
```

That is most of Pregel in one paragraph.

---

## Final takeaway

Pregel in LangGraph is basically:

- a **mailbox system** for state,
- a **round-based scheduler** for nodes,
- a **safe commit point** for updates,
- and a **save/pause/stream wrapper** around the whole thing.

So when you use LangGraph, you are mostly writing the "what should each node do?" part.

Pregel is the part quietly making sure the graph runs in a clean, repeatable, resumable way.
