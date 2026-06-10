/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, describe, beforeAll } from "vitest";
import { type PendingWrite } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import { StateGraph } from "../graph/index.js";
import { StateSchema } from "../state/schema.js";
import { START, END, Send, CONFIG_KEY_SEND } from "../constants.js";
import { NodeTimeoutError, isNodeTimeoutError } from "../errors.js";
import { entrypoint, task } from "../func/index.js";
import { RunnableCallable } from "../utils.js";
import { _runWithRetry } from "../pregel/retry.js";
import type { PregelExecutableTask } from "../pregel/types.js";
import {
  coerceTimeoutPolicy,
  type RetryPolicy,
  type TimeoutPolicy,
} from "../pregel/utils/index.js";
import type { Runtime } from "../web.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";

beforeAll(() => {
  initializeAsyncLocalStorageSingleton();
});

/** Block the event loop synchronously for ~`ms` (simulates a CPU-bound node). */
function busyWait(ms: number): void {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    }
  });
}

/**
 * Build a minimal {@link PregelExecutableTask} that runs `func` and routes its
 * writes (via CONFIG_KEY_SEND) into the same `writes` buffer exposed as
 * `task.writes`, mirroring how the real algo wires tasks.
 */
function makeTask(
  func: (input: unknown, config: any) => unknown | Promise<unknown>,
  options: {
    timeout?: number | TimeoutPolicy;
    retryPolicy?: RetryPolicy;
    name?: string;
  } = {}
): PregelExecutableTask<string, string> {
  const name = options.name ?? "timed";
  const writes: PendingWrite<string>[] = [];
  const proc = new RunnableCallable({
    func: (input: unknown, config: any) => func(input, config),
    name,
    trace: false,
    recurse: false,
  });
  return {
    name,
    input: null,
    proc: proc as any,
    writes,
    config: {
      configurable: {
        [CONFIG_KEY_SEND]: (w: PendingWrite[]) =>
          writes.push(...(w as PendingWrite<string>[])),
        thread_id: "thread-1",
      },
    },
    triggers: [name],
    retry_policy: options.retryPolicy,
    id: "task-1",
    path: ["__pregel_pull", name],
    writers: [],
    timeout: coerceTimeoutPolicy(options.timeout),
  } as PregelExecutableTask<string, string>;
}

describe("coerceTimeoutPolicy", () => {
  it("normalizes scalars, policies, and rejects non-positive timeouts", () => {
    expect(coerceTimeoutPolicy(undefined)).toBeUndefined();
    expect(coerceTimeoutPolicy(1500)).toEqual({
      runTimeout: 1500,
      idleTimeout: undefined,
      refreshOn: "auto",
    });
    expect(coerceTimeoutPolicy({ idleTimeout: 250 })).toEqual({
      runTimeout: undefined,
      idleTimeout: 250,
      refreshOn: "auto",
    });
    // empty policy collapses to undefined
    expect(coerceTimeoutPolicy({})).toBeUndefined();
    expect(() => coerceTimeoutPolicy(0)).toThrow("greater than 0");
    expect(() => coerceTimeoutPolicy({ idleTimeout: 0 })).toThrow(
      "greater than 0"
    );
    expect(() =>
      coerceTimeoutPolicy({ runTimeout: 1, refreshOn: "nope" as any })
    ).toThrow('refreshOn must be "auto" or "heartbeat"');
  });
});

describe("NodeTimeoutError", () => {
  it("carries node/kind/timeouts/elapsed and is not a graph bubble-up", () => {
    const err = new NodeTimeoutError({
      node: "n",
      elapsed: 12,
      kind: "idle",
      idleTimeout: 50,
      runTimeout: 100,
    });
    expect(err.name).toBe("NodeTimeoutError");
    expect(err.node).toBe("n");
    expect(err.kind).toBe("idle");
    expect(err.timeout).toBe(50);
    expect(err.idleTimeout).toBe(50);
    expect(err.runTimeout).toBe(100);
    expect(err.elapsed).toBe(12);
    expect(isNodeTimeoutError(err)).toBe(true);
    expect((err as any).is_bubble_up).toBeUndefined();
  });

  it("requires the matching timeout for the fired kind", () => {
    expect(
      () => new NodeTimeoutError({ node: "n", elapsed: 1, kind: "run" })
    ).toThrow("runTimeout is required");
    expect(
      () => new NodeTimeoutError({ node: "n", elapsed: 1, kind: "idle" })
    ).toThrow("idleTimeout is required");
  });
});

describe("_runWithRetry timeout enforcement", () => {
  it("fires a run timeout (kind=run)", async () => {
    const taskObj = makeTask(
      async (_input, config) => {
        await sleep(1000, config.signal);
        return "late";
      },
      { timeout: 50, name: "runslow" }
    );
    const { result, error } = await _runWithRetry(taskObj);
    expect(result).toBeUndefined();
    expect(isNodeTimeoutError(error)).toBe(true);
    const timeoutErr = error as unknown as NodeTimeoutError;
    expect(timeoutErr.kind).toBe("run");
    expect(timeoutErr.node).toBe("runslow");
    expect(timeoutErr.runTimeout).toBe(50);
  });

  it("fires an idle timeout (kind=idle) when no progress is made", async () => {
    const taskObj = makeTask(
      async (_input, config) => {
        await sleep(1000, config.signal);
        return "late";
      },
      { timeout: { idleTimeout: 50 }, name: "idleslow" }
    );
    const { error } = await _runWithRetry(taskObj);
    expect(isNodeTimeoutError(error)).toBe(true);
    expect((error as unknown as NodeTimeoutError).kind).toBe("idle");
    expect((error as unknown as NodeTimeoutError).idleTimeout).toBe(50);
  });

  it("succeeds when the node finishes within its timeout", async () => {
    const taskObj = makeTask(async () => "ok", { timeout: 1000 });
    const { result, error } = await _runWithRetry(taskObj);
    expect(error).toBeUndefined();
    expect(result).toBe("ok");
  });

  it("does not fire an idle timeout while heartbeats keep arriving", async () => {
    const taskObj = makeTask(
      async (_input, config) => {
        for (let i = 0; i < 5; i += 1) {
          await sleep(40);
          config.heartbeat?.();
        }
        return "ok";
      },
      { timeout: { idleTimeout: 120 }, name: "heartbeating" }
    );
    const { result, error } = await _runWithRetry(taskObj);
    expect(error).toBeUndefined();
    expect(result).toBe("ok");
  });

  it("under refreshOn=heartbeat, only heartbeats refresh the idle clock", async () => {
    // The node writes (an auto progress signal) but never heartbeats, so the
    // strict idle clock must still fire.
    const taskObj = makeTask(
      async (_input, config) => {
        for (let i = 0; i < 10; i += 1) {
          await sleep(30);
          config.configurable?.[CONFIG_KEY_SEND]?.([["value", i]]);
        }
        return "ok";
      },
      {
        timeout: { idleTimeout: 80, refreshOn: "heartbeat" },
        name: "strict-idle",
      }
    );
    const { error } = await _runWithRetry(taskObj);
    expect(isNodeTimeoutError(error)).toBe(true);
    expect((error as unknown as NodeTimeoutError).kind).toBe("idle");
  });

  it("aborts the node's signal when the timeout fires (combined with an external signal)", async () => {
    let sawAbort: boolean | undefined;
    const taskObj = makeTask(
      async (_input, config) => {
        try {
          await sleep(1000, config.signal);
        } catch {
          sawAbort = config.signal?.aborted ?? false;
          throw new Error("node observed abort");
        }
        return "late";
      },
      { timeout: 50, name: "abortme" }
    );
    const external = new AbortController();
    const { error } = await _runWithRetry(
      taskObj,
      undefined,
      undefined,
      external.signal
    );
    expect(isNodeTimeoutError(error)).toBe(true);
    // give the aborted background task a tick to observe the abort
    await sleep(10);
    expect(sawAbort).toBe(true);
  });

  it("does not surface an unhandled rejection when the abandoned attempt rejects after timeout", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let postTimeoutRejection = false;
    try {
      const taskObj = makeTask(
        async (_input, config) => {
          try {
            await sleep(1000, config.signal);
          } catch {
            // Timeout already fired; the invoke promise still rejects here.
            postTimeoutRejection = true;
            await sleep(0);
            throw new Error("post-timeout rejection");
          }
          return "late";
        },
        { timeout: 50, name: "late-reject" }
      );
      const { error } = await _runWithRetry(taskObj);
      expect(isNodeTimeoutError(error)).toBe(true);
      expect((error as NodeTimeoutError).node).toBe("late-reject");
      // Let the abandoned background invoke settle (reject).
      await sleep(50);
      expect(postTimeoutRejection).toBe(true);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("drops buffered writes from the timed-out attempt", async () => {
    const taskObj = makeTask(
      async (_input, config) => {
        config.configurable[CONFIG_KEY_SEND]([["value", "stale"]]);
        await sleep(1000, config.signal);
        return "late";
      },
      { timeout: 50, name: "writer" }
    );
    const { error } = await _runWithRetry(taskObj);
    expect(isNodeTimeoutError(error)).toBe(true);
    // pre-timeout writes from the failed attempt must not leak
    expect(taskObj.writes).toEqual([]);
  });

  it("enforces the run timeout for a synchronous CPU-bound node that blocks the event loop", async () => {
    // The node never yields to the event loop, so the watchdog timer (a
    // macrotask) cannot fire while it runs. The post-race wall-clock check must
    // still report a run timeout.
    const taskObj = makeTask(
      () => {
        busyWait(150);
        return "done";
      },
      { timeout: 50, name: "cpu-bound" }
    );
    const { result, error } = await _runWithRetry(taskObj);
    expect(result).toBeUndefined();
    expect(isNodeTimeoutError(error)).toBe(true);
    const timeoutErr = error as unknown as NodeTimeoutError;
    expect(timeoutErr.kind).toBe("run");
    expect(timeoutErr.node).toBe("cpu-bound");
    expect(timeoutErr.runTimeout).toBe(50);
  });

  it("discards writes from a synchronous node that blew its run budget", async () => {
    const taskObj = makeTask(
      (_input, config) => {
        config.configurable[CONFIG_KEY_SEND]([["value", "stale"]]);
        busyWait(150);
        return "done";
      },
      { timeout: 50, name: "cpu-writer" }
    );
    const { error } = await _runWithRetry(taskObj);
    expect(isNodeTimeoutError(error)).toBe(true);
    expect(taskObj.writes).toEqual([]);
  });

  it("does not falsely time out a fast synchronous node", async () => {
    const taskObj = makeTask(
      () => {
        busyWait(10);
        return "done";
      },
      { timeout: 200, name: "cpu-fast" }
    );
    const { result, error } = await _runWithRetry(taskObj);
    expect(error).toBeUndefined();
    expect(result).toBe("done");
  });

  it("is retryable under the default retry policy and resets the timer per attempt", async () => {
    let calls = 0;
    const taskObj = makeTask(
      async (_input, config) => {
        calls += 1;
        if (calls < 2) {
          await sleep(1000, config.signal);
          return "late";
        }
        return "ok";
      },
      {
        timeout: 50,
        name: "flaky",
        // default retryOn (no explicit retryOn) must treat NodeTimeoutError as retryable
        retryPolicy: { maxAttempts: 3, initialInterval: 1, logWarning: false },
      }
    );
    const { result, error } = await _runWithRetry(taskObj);
    expect(error).toBeUndefined();
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

const TimeoutState = new StateSchema({
  x: z.number(),
});

describe("addNode timeout (end-to-end)", () => {
  it("raises NodeTimeoutError when a node exceeds its run timeout", async () => {
    const graph = new StateGraph(TimeoutState)
      .addNode(
        "slow",
        async (state, runtime: Runtime) => {
          await sleep(1000, runtime.signal);
          return { x: state.x + 1 };
        },
        { timeout: 50 }
      )
      .addEdge(START, "slow")
      .addEdge("slow", END)
      .compile();

    let caught: unknown;
    try {
      await graph.invoke({ x: 1 });
    } catch (e) {
      caught = e;
    }
    expect(isNodeTimeoutError(caught)).toBe(true);
    expect((caught as NodeTimeoutError).node).toBe("slow");
  });

  it("composes with a retry policy: retries then succeeds", async () => {
    const attempts: number[] = [];
    const graph = new StateGraph(TimeoutState)
      .addNode(
        "flaky",
        async (state, runtime: Runtime) => {
          attempts.push(attempts.length);
          if (attempts.length < 2) {
            await sleep(1000, runtime.signal);
          }
          return { x: state.x + 1 };
        },
        {
          timeout: 80,
          retryPolicy: {
            maxAttempts: 3,
            initialInterval: 1,
            logWarning: false,
          },
        }
      )
      .addEdge(START, "flaky")
      .addEdge("flaky", END)
      .compile();

    const result = await graph.invoke({ x: 0 });
    expect(result).toEqual({ x: 1 });
    expect(attempts.length).toBe(2);
  });
});

describe("Send timeout (end-to-end)", () => {
  it("overrides the target node's timeout for a specific pushed task", async () => {
    const graph = new StateGraph(TimeoutState)
      .addNode(
        "slow",
        async (state, runtime: Runtime) => {
          await sleep(1000, runtime.signal);
          return { x: state.x + 1 };
        },
        // generous node-level idle timeout
        { timeout: { idleTimeout: 5000 } }
      )
      .addConditionalEdges(
        START,
        (state) => [new Send("slow", state, { timeout: { idleTimeout: 50 } })],
        ["slow"]
      )
      .addEdge("slow", END)
      .compile();

    let caught: unknown;
    try {
      await graph.invoke({ x: 1 });
    } catch (e) {
      caught = e;
    }
    expect(isNodeTimeoutError(caught)).toBe(true);
    expect((caught as NodeTimeoutError).node).toBe("slow");
    expect((caught as NodeTimeoutError).kind).toBe("idle");
    expect((caught as NodeTimeoutError).idleTimeout).toBe(50);
  });
});

describe("functional API timeout", () => {
  it("task() enforces a per-attempt timeout", async () => {
    const slowTask = task(
      { name: "slow_task", timeout: 50 },
      async (x: number) => {
        await sleep(1000);
        return x + 1;
      }
    );
    const workflow = entrypoint("wf_task", async (x: number) => {
      return await slowTask(x);
    });

    let caught: unknown;
    try {
      await workflow.invoke(1);
    } catch (e) {
      caught = e;
    }
    expect(isNodeTimeoutError(caught)).toBe(true);
  });

  it("entrypoint() enforces a per-attempt timeout", async () => {
    const slowWorkflow = entrypoint(
      { name: "wf_slow", timeout: 50 },
      async (x: number, config: any) => {
        await sleep(1000, config.signal);
        return x;
      }
    );

    let caught: unknown;
    try {
      await slowWorkflow.invoke(1);
    } catch (e) {
      caught = e;
    }
    expect(isNodeTimeoutError(caught)).toBe(true);
  });

  it("lets a child task scheduled before the timeout run to completion", async () => {
    let childRan = false;
    const child = task("child", async (value: number) => {
      childRan = true;
      return value + 1;
    });

    const parent = entrypoint(
      { name: "parent", timeout: 60 },
      async (value: number, config: any) => {
        // schedule the child before we time out
        const childPromise = child(value);
        await sleep(1000, config.signal);
        return childPromise;
      }
    );

    let caught: unknown;
    try {
      await parent.invoke(1);
    } catch (e) {
      caught = e;
    }
    expect(isNodeTimeoutError(caught)).toBe(true);
    // the already-scheduled child task still completes
    expect(childRan).toBe(true);
  });
});
