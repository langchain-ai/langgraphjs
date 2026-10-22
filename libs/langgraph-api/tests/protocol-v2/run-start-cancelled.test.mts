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

const RESOLVED_ASSISTANT_ID = "fe096781-5601-53d2-b2f6-0d3403f7e9ca";

const createService = (options: {
  pendingInterrupts: number;
  threadStatus?: string;
}) => {
  const puts: RunKwargs[] = [];
  const putAssistants: string[] = [];
  const bindings = {
    runs: {
      get: async () => interruptedRun,
      put: async (runId: string, assistantId: string, kwargs: RunKwargs) => {
        puts.push(kwargs);
        putAssistants.push(assistantId);
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
      get: async () => ({
        thread_id: THREAD_ID,
        status: options.threadStatus ?? "interrupted",
        metadata: { assistant_id: RESOLVED_ASSISTANT_ID },
      }),
      state: {
        get: async () => ({
          tasks: Array.from({ length: options.pendingInterrupts }, (_, i) => ({
            interrupts: [{ id: `interrupt-${i}`, value: { question: "proceed?" } }],
          })),
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
  return { service, puts, putAssistants };
};

const input = {
  messages: [{ type: "human", content: "narrow the scope to hand tools" }],
};

describe("run.start on a thread whose current run is interrupted", () => {
  it("submits the input as input when the interruption was a cancel (no pending interrupt)", async () => {
    const { service, puts } = createService({ pendingInterrupts: 0 });

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

  it.each([1, 2])(
    "refuses the input while %i interrupts are pending",
    async (pendingInterrupts) => {
      const { service, puts } = createService({ pendingInterrupts });

      const response = await service.handleCommand(THREAD_ID, {
        id: 1,
        method: "run.start",
        params: { assistant_id: "agent", input },
      });

      expect(response).toMatchObject({
        type: "error",
        error: "invalid_argument",
      });
      expect(puts).toHaveLength(0);
    }
  );

  it("resumes the interrupts input keyed by interrupt id answers", async () => {
    const resume = { ["a".repeat(32)]: "yes", ["b".repeat(32)]: "no" };
    const { service, puts } = createService({ pendingInterrupts: 2 });

    const response = await service.handleCommand(THREAD_ID, {
      id: 1,
      method: "run.start",
      params: { assistant_id: "agent", input: resume },
    });

    expect(response).toMatchObject({ type: "success" });
    expect(puts).toHaveLength(1);
    expect(puts[0].command).toEqual({ resume });
  });

  it("starts a new run when the input forks from a checkpoint", async () => {
    const { service, puts } = createService({ pendingInterrupts: 1 });
    const config = { configurable: { checkpoint_id: "checkpoint-1" } };

    const response = await service.handleCommand(THREAD_ID, {
      id: 1,
      method: "run.start",
      params: { assistant_id: "agent", input, config },
    });

    expect(response).toMatchObject({ type: "success" });
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toEqual(input);
    expect(puts[0].command).toBeUndefined();
  });

  it("starts a new run for run.start without input", async () => {
    const { service, puts } = createService({ pendingInterrupts: 1 });

    const response = await service.handleCommand(THREAD_ID, {
      id: 1,
      method: "run.start",
      params: { assistant_id: "agent", input: null },
    });

    expect(response).toMatchObject({ type: "success" });
    expect(puts).toHaveLength(1);
    expect(puts[0].command).toBeUndefined();
  });

  it("answers input.respond on a thread no run.start has bound since a restart", async () => {
    const { service, puts, putAssistants } = createService({
      pendingInterrupts: 1,
    });

    const response = await service.handleCommand(THREAD_ID, {
      id: 1,
      method: "input.respond",
      params: { interrupt_id: "interrupt-0", namespace: [], response: "yes" },
    });

    expect(response).toMatchObject({ type: "success" });
    expect(puts[0].command).toMatchObject({ resume: { "interrupt-0": "yes" } });
    expect(putAssistants).toEqual([RESOLVED_ASSISTANT_ID]);

    const next = await service.handleCommand(THREAD_ID, {
      id: 2,
      method: "run.start",
      params: { assistant_id: "agent", input: null },
    });
    expect(next).toMatchObject({ type: "success" });
  });

  it("starts a new run while a run is in flight", async () => {
    const { service, puts } = createService({
      pendingInterrupts: 2,
      threadStatus: "busy",
    });

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
});
