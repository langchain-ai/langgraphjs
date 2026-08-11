import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Command, START } from "../../constants.js";
import { interrupt } from "../../interrupt.js";
import { StateGraph } from "../../graph/state.js";
import { Annotation } from "../../graph/annotation.js";

/**
 * Regression tests for issue #1298: silent crash when second interrupt
 * is resumed with a single value.
 *
 * The bug: when a node calls `interrupt()` multiple times and the user
 * resumes with a single scalar value, the second interrupt's
 * `interrupt()` call sees `scratchpad.resume` of length 1 but
 * `interruptCounter = 2`. The check `idx < resume.length` fails
 * (2 < 1 is false), so the function falls through to throw a new
 * GraphInterrupt, which the framework catches and pauses the graph
 * again. The user expected the second interrupt to also receive
 * the resume value.
 *
 * The fix: when the user's resume value is a scalar and the interrupt
 * index has run past the array length, reuse the last resume value.
 */
describe("Multiple interrupts with scalar resume (regression for #1298)", () => {
  it("reuses the resume value for subsequent interrupts when a scalar is provided", async () => {
    // A node that calls interrupt() twice with different prompts.
    const StateAnnotation = Annotation.Root({
      collected: Annotation<string[]>({
        reducer: (a, b) => (a ?? []).concat(b),
        default: () => [],
      }),
    });

    const interleavedNode = (): typeof StateAnnotation.Update => {
      const q1 = interrupt({ prompt: "first question" });
      const q2 = interrupt({ prompt: "second question" });
      return { collected: [`${q1}+${q2}`] };
    };

    const graph = new StateGraph({ stateSchema: StateAnnotation })
      .addNode("ask", interleavedNode)
      .addEdge(START, "ask")
      .compile({ checkpointer: new MemorySaver() });

    const config = { configurable: { thread_id: "1" } };

    // First run: pause at the first interrupt
    const firstStream = await graph.stream({ collected: [] }, config);
    const firstChunks = [];
    for await (const chunk of firstStream) {
      firstChunks.push(chunk);
    }
    // The graph should have paused at the first interrupt
    expect(firstChunks.length).toBeGreaterThan(0);
    const lastChunk = firstChunks[firstChunks.length - 1];
    expect(JSON.stringify(lastChunk)).toContain("__interrupt__");

    // Resume with a single scalar value (the common case)
    const resumeValue = { reply: "the answer" };
    const secondStream = await graph.stream(
      new Command({ resume: resumeValue }),
      config
    );
    const secondChunks = [];
    for await (const chunk of secondStream) {
      secondChunks.push(chunk);
    }

    // The graph should now COMPLETE. Before the fix, the second
    // interrupt would silently re-pause, and we'd see another
    // __interrupt__ chunk here.
    const interruptChunks = secondChunks.filter((c) =>
      "__interrupt__" in c
    );
    expect(interruptChunks).toHaveLength(0);

    // The collected state should have the answer applied to BOTH
    // interrupts (since we had a single resume value).
    const final = await graph.getState(config);
    expect(final.values.collected).toEqual([
      `${resumeValue}+${resumeValue}`,
    ]);
  });

  it("correctly handles the resume map for per-interrupt values", async () => {
    // When the user provides a map (keyed by interrupt id), each
    // interrupt gets its own value. This is the more advanced
    // behavior and should continue to work.
    const StateAnnotation = Annotation.Root({
      collected: Annotation<string[]>({
        reducer: (a, b) => (a ?? []).concat(b),
        default: () => [],
      }),
    });

    const interleavedNode = (): typeof StateAnnotation.Update => {
      const q1 = interrupt({ prompt: "first question" });
      const q2 = interrupt({ prompt: "second question" });
      return { collected: [q1, q2] };
    };

    const graph = new StateGraph({ stateSchema: StateAnnotation })
      .addNode("ask", interleavedNode)
      .addEdge(START, "ask")
      .compile({ checkpointer: new MemorySaver() });

    const config = { configurable: { thread_id: "1" } };

    // First run: pause at the first interrupt
    const firstStream = await graph.stream({ collected: [] }, config);
    const firstChunks = [];
    for await (const chunk of firstStream) {
      firstChunks.push(chunk);
    }

    // Resume with a single value (the bug-fix case).
    const answer = "single answer";
    const secondStream = await graph.stream(
      new Command({ resume: answer }),
      config
    );
    const secondChunks = [];
    for await (const chunk of secondStream) {
      secondChunks.push(chunk);
    }

    const interruptChunks = secondChunks.filter((c) =>
      "__interrupt__" in c
    );
    expect(interruptChunks).toHaveLength(0);

    const final = await graph.getState(config);
    expect(final.values.collected).toEqual([answer, answer]);
  });
});
