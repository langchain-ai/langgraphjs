import { describe, expect, it } from "vitest";
import type { LifecycleCause, LifecycleData } from "@langchain/protocol";

import { StreamMux } from "../mux.js";
import {
  collectAsyncIterable,
  makeProtocolEvent,
} from "../test-utils.js";
import { createLifecycleTransformer } from "./lifecycle.js";
import type {
  Namespace,
  NativeStreamTransformer,
  ProtocolEvent,
} from "../types.js";

function makeEvent(
  method: string,
  ns: Namespace = [],
  data: unknown = {},
  opts?: { node?: string; seq?: number }
): ProtocolEvent {
  return makeProtocolEvent(method, {
    namespace: ns,
    data,
    node: opts?.node,
    seq: opts?.seq,
  });
}

function isLifecycle(event: ProtocolEvent): boolean {
  return event.method === "lifecycle";
}

function installTransformer(
  mux: StreamMux,
  transformer: NativeStreamTransformer<unknown>
): void {
  mux.addTransformer(transformer);
}

async function drainEvents(mux: StreamMux): Promise<ProtocolEvent[]> {
  return collectAsyncIterable(mux._events.toAsyncIterable());
}

function lifecyclePayload(event: ProtocolEvent): LifecycleData {
  return event.params.data as LifecycleData;
}

describe("createLifecycleTransformer", () => {
  it("emits root lifecycle.running on register and completed on finalize", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({ rootGraphName: "myGraph" });
    installTransformer(mux, transformer);

    transformer.finalize?.();
    mux.close();

    const events = await drainEvents(mux);
    const lifecycle = events.filter((e) => isLifecycle(e));
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0].params.namespace).toEqual([]);
    expect(lifecyclePayload(lifecycle[0]).event).toBe("running");
    expect(lifecyclePayload(lifecycle[0]).graph_name).toBe("myGraph");
    expect(lifecycle[1].params.namespace).toEqual([]);
    expect(lifecyclePayload(lifecycle[1]).event).toBe("completed");
  });

  it("skips root emission when emitRootOnRegister is false", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      emitRootOnRegister: false,
    });
    installTransformer(mux, transformer);

    transformer.finalize?.();
    mux.close();

    const events = await drainEvents(mux);
    const lifecycle = events.filter((e) => isLifecycle(e));
    // Root lifecycle events are suppressed; child cascade still runs
    // but there are no child namespaces yet => empty.
    expect(lifecycle).toHaveLength(0);
  });

  it("synthesizes started for unseen prefixes before the triggering event", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      emitRootOnRegister: false,
    });
    installTransformer(mux, transformer);

    mux.push(["agent:0"], makeEvent("values", ["agent:0"], { x: 1 }));
    transformer.finalize?.();
    mux.close();

    const events = await drainEvents(mux);
    const methods = events.map((e) => e.method);
    // Order: lifecycle.started for child => values => lifecycle.completed cascade.
    expect(methods[0]).toBe("lifecycle");
    expect(events[0].params.namespace).toEqual(["agent:0"]);
    expect(lifecyclePayload(events[0]).event).toBe("started");
    expect(lifecyclePayload(events[0]).graph_name).toBe("agent");
    expect(methods[1]).toBe("values");
  });

  it("emits lifecycle.completed for child namespaces after a parent updates.node event", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      emitRootOnRegister: false,
    });
    installTransformer(mux, transformer);

    // Discover child namespace.
    mux.push(["researcher:abc"], makeEvent("values", ["researcher:abc"], {}));
    // Parent updates with node - cues child completion.
    mux.push([], makeEvent("updates", [], { foo: 1 }, { node: "researcher" }));
    // Next event flushes the pending completion.
    mux.push([], makeEvent("values", [], { final: true }));
    transformer.finalize?.();
    mux.close();

    const events = await drainEvents(mux);
    const lifecycleEvents = events.filter((e) => isLifecycle(e));

    // Should contain: started(researcher:abc), completed(researcher:abc), completed(root).
    const childCompletedIdx = lifecycleEvents.findIndex(
      (e) =>
        e.params.namespace[0] === "researcher:abc" &&
        lifecyclePayload(e).event === "completed"
    );
    expect(childCompletedIdx).toBeGreaterThanOrEqual(0);

    // Wire order: the child's completed must come AFTER the parent updates.
    const updatesIdx = events.findIndex(
      (e) => e.method === "updates" && e.params.namespace.length === 0
    );
    const childCompletedGlobalIdx = events.findIndex(
      (e) =>
        isLifecycle(e) &&
        e.params.namespace[0] === "researcher:abc" &&
        lifecyclePayload(e).event === "completed"
    );
    expect(updatesIdx).toBeGreaterThanOrEqual(0);
    expect(childCompletedGlobalIdx).toBeGreaterThan(updatesIdx);
  });

  it("prefers exact tasks result ids over pending updates.node completions", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      emitRootOnRegister: false,
    });
    installTransformer(mux, transformer);

    mux.push(["researcher:a"], makeEvent("values", ["researcher:a"], {}));
    mux.push(["researcher:b"], makeEvent("values", ["researcher:b"], {}));
    // This ambiguous update would previously complete the oldest researcher child.
    mux.push([], makeEvent("updates", [], { result: "b" }, { node: "researcher" }));
    mux.push(
      [],
      makeEvent("tasks", [], {
        id: "b",
        name: "researcher",
        result: { result: "b" },
        interrupts: [],
      })
    );
    // Next event flushes the exact completion from the task result.
    mux.push([], makeEvent("values", [], { final: true }));
    mux.close();

    const events = await drainEvents(mux);
    const taskResultIdx = events.findIndex(
      (e) => e.method === "tasks" && (e.params.data as { id?: string }).id === "b"
    );
    const finalValuesIdx = events.findIndex(
      (e) =>
        e.method === "values" &&
        e.params.namespace.length === 0 &&
        (e.params.data as { final?: boolean }).final === true
    );
    const completedIdx = events.findIndex(
      (e) =>
        isLifecycle(e) &&
        e.params.namespace[0] === "researcher:b" &&
        lifecyclePayload(e).event === "completed"
    );
    const otherChildCompletedIdx = events.findIndex(
      (e) =>
        isLifecycle(e) &&
        e.params.namespace[0] === "researcher:a" &&
        lifecyclePayload(e).event === "completed"
    );

    expect(completedIdx).toBeGreaterThan(taskResultIdx);
    expect(completedIdx).toBeLessThan(finalValuesIdx);
    // The ambiguous update should not complete the oldest sibling before
    // the exact task result has a chance to identify the real child.
    expect(otherChildCompletedIdx).toBeGreaterThan(finalValuesIdx);
  });

  it("emits a single completion when tasks result and updates.node both signal the same child", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      emitRootOnRegister: false,
    });
    installTransformer(mux, transformer);

    mux.push(["researcher:abc"], makeEvent("values", ["researcher:abc"], {}));
    mux.push(
      [],
      makeEvent("tasks", [], {
        id: "abc",
        name: "researcher",
        result: { ok: true },
        interrupts: [],
      })
    );
    // Flushes the task-result completion, then should not enqueue another one.
    mux.push([], makeEvent("updates", [], { ok: true }, { node: "researcher" }));
    mux.push([], makeEvent("values", [], { final: true }));
    mux.close();

    const events = await drainEvents(mux);
    const completedForChild = events.filter(
      (e) =>
        isLifecycle(e) &&
        e.params.namespace[0] === "researcher:abc" &&
        lifecyclePayload(e).event === "completed"
    );

    expect(completedForChild).toHaveLength(1);
  });

  it("cascades failed status to all still-started namespaces on fail()", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer();
    installTransformer(mux, transformer);

    mux.push(["a:0"], makeEvent("values", ["a:0"], {}));
    mux.push(["a:0", "b:0"], makeEvent("values", ["a:0", "b:0"], {}));
    transformer.fail?.(new Error("boom"));
    mux.close();

    const events = await drainEvents(mux);
    const failed = events.filter(
      (e) => isLifecycle(e) && lifecyclePayload(e).event === "failed"
    );
    // Expect failed for [a:0], [a:0, b:0], and root.
    expect(failed.length).toBe(3);
    const rootFailed = failed.find((e) => e.params.namespace.length === 0);
    expect(rootFailed).toBeDefined();
    expect(lifecyclePayload(rootFailed!).error).toBe("boom");
  });

  it("suppresses upstream lifecycle.started events and re-emits with stashed cause", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      emitRootOnRegister: false,
    });
    installTransformer(mux, transformer);

    const cause: LifecycleCause = {
      type: "tool_call",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    mux.push(
      ["tools:t1"],
      makeEvent("lifecycle", ["tools:t1"], {
        event: "started",
        graph_name: "tools",
        cause,
      })
    );
    transformer.finalize?.();
    mux.close();

    const events = await drainEvents(mux);
    const lifecycleEvents = events.filter((e) => isLifecycle(e));

    // The upstream lifecycle event should be suppressed and a single
    // authoritative `started` with the stashed cause should appear.
    const startedForTool = lifecycleEvents.filter(
      (e) =>
        e.params.namespace[0] === "tools:t1" &&
        lifecyclePayload(e).event === "started"
    );
    expect(startedForTool).toHaveLength(1);
    expect(lifecyclePayload(startedForTool[0]).cause).toEqual(cause);
  });

  it("infers graph name from the last namespace segment by default", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      emitRootOnRegister: false,
    });
    installTransformer(mux, transformer);

    mux.push(
      ["subagent:xyz"],
      makeEvent("values", ["subagent:xyz"], {})
    );
    transformer.finalize?.();
    mux.close();

    const events = await drainEvents(mux);
    const started = events.find(
      (e) =>
        isLifecycle(e) &&
        e.params.namespace[0] === "subagent:xyz" &&
        lifecyclePayload(e).event === "started"
    );
    expect(started).toBeDefined();
    expect(lifecyclePayload(started!).graph_name).toBe("subagent");
  });

  it("respects getTerminalStatusOverride when provided", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({
      getTerminalStatusOverride: async () => "interrupted",
    });
    installTransformer(mux, transformer);

    mux.push(["a:0"], makeEvent("values", ["a:0"], {}));
    transformer.finalize?.();
    // Give microtasks a chance to resolve the async finalize.
    await new Promise((r) => setTimeout(r, 0));
    mux.close();

    const events = await drainEvents(mux);
    const interrupted = events.filter(
      (e) =>
        isLifecycle(e) &&
        lifecyclePayload(e).event === "interrupted"
    );
    // Both child and root should land on interrupted.
    expect(interrupted.length).toBeGreaterThanOrEqual(2);
    const rootInterrupted = interrupted.find(
      (e) => e.params.namespace.length === 0
    );
    expect(rootInterrupted).toBeDefined();
  });

  it("cascades interrupted when input.requested events are seen", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer();
    installTransformer(mux, transformer);

    mux.push(
      [],
      makeEvent("input", [], { event: "requested", id: "int-1" })
    );
    transformer.finalize?.();
    await new Promise((r) => setTimeout(r, 0));
    mux.close();

    const events = await drainEvents(mux);
    const interrupted = events.filter(
      (e) =>
        isLifecycle(e) &&
        lifecyclePayload(e).event === "interrupted"
    );
    expect(interrupted.length).toBeGreaterThanOrEqual(1);
  });

  it("exposes a _lifecycleLog projection iterable by consumers", async () => {
    const mux = new StreamMux();
    const transformer = createLifecycleTransformer({ rootGraphName: "g" });
    const projection = transformer.init();
    installTransformer(mux, transformer);

    mux.push(["child:0"], makeEvent("values", ["child:0"], {}));
    transformer.finalize?.();
    await new Promise((r) => setTimeout(r, 0));
    mux.close();

    const entries: unknown[] = [];
    for await (const entry of projection._lifecycleLog.toAsyncIterable()) {
      entries.push(entry);
    }
    // Expect at least: root running, child started, cascade completed for child + root.
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });
});
