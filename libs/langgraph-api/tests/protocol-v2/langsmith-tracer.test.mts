import { describe, expect, it } from "vitest";

import { ProtocolService } from "../../src/protocol/service.mjs";
import type { Run, RunKwargs } from "../../src/storage/types.mjs";

const THREAD_ID = "00000000-0000-7000-8000-000000000004";

const createService = () => {
  const puts: RunKwargs[] = [];
  const bindings = {
    runs: {
      get: async () => null,
      put: async (runId: string, _assistantId: string, kwargs: RunKwargs) => {
        puts.push(kwargs);
        return [
          {
            run_id: runId,
            thread_id: THREAD_ID,
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
      get: async () => ({ thread_id: THREAD_ID, status: "idle" }),
      state: {
        get: async () => ({ tasks: [] }),
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
  record.assistantId = "agent";
  return { service, puts };
};

// `langsmith_tracer` is part of the protocol's `RunStartParams`, and both
// the legacy run endpoints and the embed server fold it into
// `config.configurable`. `run.start` must do the same, otherwise a client
// that streams over the protocol traces to the deployment's default
// LangSmith project instead of the one it asked for.
describe("run.start langsmith_tracer", () => {
  it("folds the tracer into the run config", async () => {
    const { service, puts } = createService();

    const response = await service.handleCommand(
      THREAD_ID,
      {
        id: 1,
        method: "run.start",
        params: {
          assistant_id: "agent",
          input: { messages: [] },
          langsmith_tracer: {
            project_name: "custom-project",
            example_id: "example-1",
          },
        },
      },
      undefined
    );

    expect(response).toMatchObject({ type: "success" });
    expect(puts).toHaveLength(1);
    expect(puts[0].config?.configurable).toMatchObject({
      thread_id: THREAD_ID,
      langsmith_project: "custom-project",
      langsmith_example_id: "example-1",
    });
  });

  it("keeps the caller's own configurable fields", async () => {
    const { service, puts } = createService();

    await service.handleCommand(
      THREAD_ID,
      {
        id: 2,
        method: "run.start",
        params: {
          assistant_id: "agent",
          input: { messages: [] },
          config: { configurable: { model: "gpt-5" } },
          langsmith_tracer: { project_name: "custom-project" },
        },
      },
      undefined
    );

    expect(puts[0].config?.configurable).toMatchObject({
      thread_id: THREAD_ID,
      model: "gpt-5",
      langsmith_project: "custom-project",
    });
    expect(puts[0].config?.configurable).not.toHaveProperty(
      "langsmith_example_id",
      "example-1"
    );
  });

  it("leaves the config alone when no tracer is sent", async () => {
    const { service, puts } = createService();

    await service.handleCommand(
      THREAD_ID,
      {
        id: 3,
        method: "run.start",
        params: { assistant_id: "agent", input: { messages: [] } },
      },
      undefined
    );

    expect(puts[0].config?.configurable).not.toHaveProperty("langsmith_project");
    expect(puts[0].config?.configurable).not.toHaveProperty(
      "langsmith_example_id"
    );
  });

  it("ignores a malformed tracer instead of failing the run", async () => {
    const { service, puts } = createService();

    const response = await service.handleCommand(
      THREAD_ID,
      {
        id: 4,
        method: "run.start",
        params: {
          assistant_id: "agent",
          input: { messages: [] },
          langsmith_tracer: "not-an-object",
        },
      },
      undefined
    );

    expect(response).toMatchObject({ type: "success" });
    expect(puts[0].config?.configurable).not.toHaveProperty("langsmith_project");
  });
});
