/**
 * `run.start` with input must fold the input into `Command(resume)` only
 * when the thread actually has a pending `interrupt()`.
 *
 * A cancelled run also ends with status "interrupted", but there is no
 * pending interrupt to consume the resume value — LangGraph only delivers
 * resume values to an `interrupt()` call. Treating that submit as a resume
 * therefore silently drops the user's message and re-runs the interrupted
 * node with stale state. The stop-then-send flow (SDK `stop()` cancels the
 * run, then the user sends a follow-up message) hits exactly this.
 */
import { describe, expect, it } from "vitest";

import { ProtocolService } from "../../src/protocol/service.mjs";
import type { Run, RunKwargs } from "../../src/storage/types.mjs";

const THREAD_ID = "00000000-0000-7000-8000-000000000002";

const interruptedRun = {
  run_id: "00000000-0000-7000-8000-000000000001",
  thread_id: THREAD_ID,
  status: "interrupted",
  kwargs: {},
} as unknown as Run;

const createService = (options: { pendingInterrupts: boolean }) => {
  const puts: RunKwargs[] = [];
  const bindings = {
    runs: {
      get: async () => interruptedRun,
      put: async (runId: string, _assistantId: string, kwargs: RunKwargs) => {
        puts.push(kwargs);
        return [
          {
            ...interruptedRun,
            run_id: runId,
            status: "pending",
            kwargs,
          } as unknown as Run,
        ];
      },
      stream: {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        join: () => (async function* () {})(),
      },
    },
    threads: {
      state: {
        get: async () => ({
          tasks: [
            {
              interrupts: options.pendingInterrupts
                ? [{ id: "interrupt-1", value: { question: "proceed?" } }]
                : [],
            },
          ],
        }),
      },
    },
  };
  const service = new ProtocolService(
    bindings as unknown as ConstructorParameters<typeof ProtocolService>[0]
  );
  const record = service.ensureThread({
    threadId: THREAD_ID,
    transport: "sse-http",
  });
  record.currentRunId = interruptedRun.run_id;
  return { service, puts };
};

const input = {
  messages: [{ type: "human", content: "narrow the scope to hand tools" }],
};

describe("run.start on a thread whose current run is interrupted", () => {
  it("submits the input as input when the interruption was a cancel (no pending interrupt)", async () => {
    const { service, puts } = createService({ pendingInterrupts: false });

    const response = await service.handleCommand(THREAD_ID, {
      id: 1,
      method: "run.start",
      params: { assistant_id: "agent", input },
    });

    expect(response).toMatchObject({ type: "success" });
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toEqual(input);
    expect(puts[0].command).toBeUndefined();
  });

  it("still folds the input into Command(resume) when an interrupt is pending", async () => {
    const { service, puts } = createService({ pendingInterrupts: true });

    const response = await service.handleCommand(THREAD_ID, {
      id: 1,
      method: "run.start",
      params: { assistant_id: "agent", input },
    });

    expect(response).toMatchObject({ type: "success" });
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toBeNull();
    expect(puts[0].command).toEqual({ resume: input });
  });
});
