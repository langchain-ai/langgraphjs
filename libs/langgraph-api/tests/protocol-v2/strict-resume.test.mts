import { describe, expect, it } from "vitest";

import { ProtocolService } from "../../src/protocol/service.mjs";
import type { Run, RunKwargs } from "../../src/storage/types.mjs";

const THREAD_ID = "00000000-0000-7000-8000-000000000003";

const interruptedRun = {
  run_id: "00000000-0000-7000-8000-000000000001",
  thread_id: THREAD_ID,
  status: "interrupted",
  kwargs: {},
} as unknown as Run;

const createService = () => {
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
      get: async () => ({ thread_id: THREAD_ID, status: "interrupted" }),
      state: {
        get: async () => ({
          tasks: [{ interrupts: [{ id: "a".repeat(32), value: "proceed?" }] }],
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
  record.assistantId = "agent";
  return { service, puts };
};

// Each way to answer an interrupt over the protocol, with and without
// `strict_resume`: only that field sets the run's `strict_resume`.
describe.each([
  {
    method: "run.start" as const,
    params: { assistant_id: "agent", input: { ["a".repeat(32)]: "yes" } },
  },
  {
    method: "input.respond" as const,
    params: { interrupt_id: "a".repeat(32), response: "yes" },
  },
])("$method", ({ method, params }) => {
  it.each([
    { strict_resume: true, expected: true },
    { strict_resume: undefined, expected: undefined },
  ])(
    "with strict_resume $strict_resume sets the run's strict_resume $expected",
    async ({ strict_resume, expected }) => {
      const { service, puts } = createService();

      const response = await service.handleCommand(
        THREAD_ID,
        { id: 1, method, params: { ...params, strict_resume } },
        undefined
      );

      expect(response).toMatchObject({ type: "success" });
      expect(puts.map((kwargs) => kwargs.strict_resume)).toEqual([expected]);
    }
  );
});
