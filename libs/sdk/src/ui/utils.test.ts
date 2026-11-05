import { describe, expect, it } from "vitest";
import type { Client } from "../client.js";
import type { RunsStreamPayload } from "../types.js";
import { onFinishRequiresThreadState, streamRun } from "./utils.js";

describe("onFinishRequiresThreadState", () => {
  it("is false for undefined", () => {
    expect(onFinishRequiresThreadState(undefined)).toBe(false);
  });

  it("is false for zero-arity callbacks", () => {
    expect(onFinishRequiresThreadState(() => {})).toBe(false);
  });

  it("is true when the callback declares parameters", () => {
    expect(onFinishRequiresThreadState((_s: unknown) => {})).toBe(true);
    expect(onFinishRequiresThreadState((_s: unknown, _r: unknown) => {})).toBe(
      true
    );
  });
});

describe("streamRun", () => {
  type Step = "stop" | "abort" | "respond" | "fail";
  const cases: Array<{
    name: string;
    steps: Step[];
    log: string[];
    stoppable?: false;
  }> = [
    {
      name: "a stop before the run id cancels that run once the id arrives",
      steps: ["stop", "respond"],
      log: ["stop", "ended", "respond", "cancel t1 run-1", "closed"],
    },
    {
      name: "a second stop sends no second cancel",
      steps: ["stop", "stop", "respond"],
      log: ["stop", "ended", "stop", "respond", "cancel t1 run-1", "closed"],
    },
    {
      name: "a request that fails after a stop cancels nothing",
      steps: ["stop", "fail"],
      log: ["stop", "ended", "fail", "closed"],
    },
    {
      name: "an abort that is not a stop closes the request at once",
      steps: ["abort", "respond"],
      log: ["abort", "closed", "ended", "respond"],
    },
    {
      name: "a stop after the run id closes the request at once",
      steps: ["respond", "stop"],
      log: [
        "respond",
        "created run-1",
        "metadata",
        "stop",
        "closed",
        "AbortError",
        "ended",
      ],
    },
    {
      name: "without a stop signal the call passes straight through",
      stoppable: false,
      steps: ["abort", "respond"],
      log: ["abort", "closed", "AbortError", "ended", "respond"],
    },
  ];

  for (const { name, steps, log: expected, stoppable = true } of cases) {
    it(name, async () => {
      const log: string[] = [];
      const signal = new AbortController();
      const stop = new AbortController();
      let respond!: () => void;
      let fail!: (error: Error) => void;
      const response = new Promise<void>((resolve, reject) => {
        respond = resolve;
        fail = reject;
      });
      const aborted = (request: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          const error = Object.assign(new Error("aborted"), {
            name: "AbortError",
          });
          request.addEventListener("abort", () => reject(error));
        });
      const client = {
        runs: {
          stream: (
            threadId: string,
            _assistantId: string,
            payload: RunsStreamPayload & { signal: AbortSignal }
          ) => {
            payload.signal.addEventListener("abort", () => log.push("closed"));
            return (async function* () {
              await Promise.race([response, aborted(payload.signal)]);
              payload.onRunCreated?.({ run_id: "run-1", thread_id: threadId });
              yield { event: "metadata", data: {} };
              await aborted(payload.signal);
            })();
          },
          cancel: async (threadId: string, runId: string) => {
            log.push(`cancel ${threadId} ${runId}`);
          },
        },
      } as unknown as Client;

      void (async () => {
        try {
          for await (const part of streamRun(client, "t1", "agent", {
            signal: signal.signal,
            stopSignal: stoppable ? stop.signal : undefined,
            onRunCreated: ({ run_id }) => log.push(`created ${run_id}`),
          })) {
            log.push((part as { event: string }).event);
          }
        } catch (error) {
          log.push((error as Error).name);
        }
        log.push("ended");
      })();

      const take: Record<Step, () => void> = {
        stop: () => {
          stop.abort();
          signal.abort();
        },
        abort: () => signal.abort(),
        respond,
        fail: () => fail(new Error("offline")),
      };
      for (const step of steps) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        log.push(step);
        take[step]();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(log).toEqual(expected);
    });
  }
});
