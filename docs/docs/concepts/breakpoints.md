# Breakpoints

Breakpoints pause graph execution at specific points and enable stepping through execution step by step. Breakpoints are powered by LangGraph's [**persistence layer**](./persistence.md), which saves the state after each graph step. Breakpoints can also be used to enable [**human-in-the-loop**](./human_in_the_loop.md) workflows, though we recommend using the [`interrupt` function](./human_in_the_loop.md#interrupt) for this purpose.

## Requirements

To use breakpoints, you will need to:

1. [**Specify a checkpointer**](persistence.md#checkpoints) to save the graph state after each step.

2. [**Set breakpoints**](#setting-breakpoints) to specify where execution should pause.

3. **Run the graph** with a [**thread ID**](./persistence.md#threads) to pause execution at the breakpoint.

4. **Resume execution** using `invoke`/`stream` (see [**The `Command` primitive**](./human_in_the_loop.md#the-command-primitive)).

## Setting breakpoints

There are two places where you can set breakpoints:

1. **Before** or **after** a node executes by setting breakpoints at **compile time** or **run time**. We call these [**static breakpoints**](#static-breakpoints).

2. **Inside** a node using the [`NodeInterrupt` error](#nodeinterrupt-error).

### Static breakpoints

Static breakpoints are triggered either **before** or **after** a node executes. You can set static breakpoints by specifying `interruptBefore` and `interruptAfter` at **"compile" time** or **run time**.

=== "Compile time"

    ```typescript
    const graph = graphBuilder.compile({
        interruptBefore: ["nodeA"],
        interruptAfter: ["nodeB", "nodeC"],
        checkpointer: ..., // Specify a checkpointer
    });

    const threadConfig = {
        configurable: {
            thread_id: "someThread"
        }
    };

    // Run the graph until the breakpoint
    await graph.invoke(inputs, threadConfig);

    // Optionally update the graph state based on user input
    await graph.updateState(update, threadConfig);

    // Resume the graph
    await graph.invoke(null, threadConfig);
    ```

=== "Run time"

    ```typescript
    await graph.invoke(
        inputs,
        { 
            configurable: { thread_id: "someThread" },
            interruptBefore: ["nodeA"],
            interruptAfter: ["nodeB", "nodeC"]
        }
    );

    const threadConfig = {
        configurable: {
            thread_id: "someThread"
        }
    };

    // Run the graph until the breakpoint
    await graph.invoke(inputs, threadConfig);

    // Optionally update the graph state based on user input
    await graph.updateState(update, threadConfig);

    // Resume the graph
    await graph.invoke(null, threadConfig);
    ```

    !!! note

        You cannot set static breakpoints at runtime for **sub-graphs**.

        If you have a sub-graph, you must set the breakpoints at compilation time.

Static breakpoints can be especially useful for debugging if you want to step through the graph execution one
node at a time or if you want to pause the graph execution at specific nodes.

### `NodeInterrupt` error

We recommend that you [**use the `interrupt` function instead**](#the-interrupt-function) of the `NodeInterrupt` error if you're trying to implement
[human-in-the-loop](./human_in_the_loop.md) workflows. The `interrupt` function is easier to use and more flexible.

??? node "`NodeInterrupt` error"

    The developer can define some *condition* that must be met for a breakpoint to be triggered. This concept of [dynamic breakpoints](./low_level.md#dynamic-breakpoints) is useful when the developer wants to halt the graph under *a particular condition*. This uses a `NodeInterrupt`, which is a special type of error that can be thrown from within a node based upon some condition. As an example, we can define a dynamic breakpoint that triggers when the `input` is longer than 5 characters.

    ```typescript
    function myNode(state: typeof GraphAnnotation.State) {
        if (state.input.length > 5) {
            throw new NodeInterrupt(`Received input that is longer than 5 characters: ${state.input}`);
        }
        return state;
    }
    ```

    Let's assume we run the graph with an input that triggers the dynamic breakpoint and then attempt to resume the graph execution simply by passing in `null` for the input.

    ```typescript
    // Attempt to continue the graph execution with no change to state after we hit the dynamic breakpoint 
    for await (const event of await graph.stream(null, threadConfig)) {
        console.log(event);
    }
    ```

    The graph will *interrupt* again because this node will be *re-run* with the same graph state. We need to change the graph state such that the condition that triggers the dynamic breakpoint is no longer met. So, we can simply edit the graph state to an input that meets the condition of our dynamic breakpoint (< 5 characters) and re-run the node.

    ```typescript
    // Update the state to pass the dynamic breakpoint
    await graph.updateState({ input: "foo" }, threadConfig);

    for await (const event of await graph.stream(null, threadConfig)) {
        console.log(event);
    }
    ```

    Alternatively, what if we want to keep our current input and skip the node (`myNode`) that performs the check? To do this, we can simply perform the graph update with `"myNode"` (the node name) as the third positional argument, and pass in `null` for the values. This will make no update to the graph state, but run the update as `myNode`, effectively skipping the node and bypassing the dynamic breakpoint.

    ```typescript
    // This update will skip the node `myNode` altogether
    await graph.updateState(null, threadConfig, "myNode");

    for await (const event of await graph.stream(null, threadConfig)) {
        console.log(event);
    }
    ```

## Additional Resources 📚

- [**Conceptual Guide: Persistence**](persistence.md): Read the persistence guide for more context about persistence.

- [**Conceptual Guide: Human-in-the-loop**](human_in_the_loop.md): Read the human-in-the-loop guide for more context on integrating human feedback into LangGraph applications using breakpoints.

- [**How to View and Update Past Graph State**](/langgraphjs/how-tos/time-travel): Step-by-step instructions for working with graph state that demonstrate the **replay** and **fork** actions.
