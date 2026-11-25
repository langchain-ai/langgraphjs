/**
 * `run.start` must fold `langsmith_tracer` into `config.configurable` using the
 * same shape the REST run endpoints use (`createValidRun`). Otherwise a run
 * created over the thread protocol traces to the default LangSmith project
 * instead of the project/example the caller asked for.
 */
import { describe, expect, it } from "vitest";

import { ProtocolService } from "../../src/protocol/service.mjs";
import type { Run, RunKwargs } from "../../src/storage/types.mjs";

const THREAD_ID = "00000000-0000-7000-8000-000000000004";

const TRACER = { project_name: "my-project", example_id: "ex-1" };

const createService = () => {
  const puts: RunKwargs[] = [];
  const bindings = {
    runs: {
      get: async () => undefined,
      put: async (runId: string, _assistantId: string, kwargs: RunKwargs) => {
        puts.push(kwargs);
        return [
          {
            ...({ run_id: runId, thread_id: THREAD_ID, kwargs } as Run),
            status: "pending",
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
      state: { get: async () => ({ tasks: [] }) },
    },
  };
  const service = new ProtocolService(
    bindings as unknown as ConstructorParameters<typeof ProtocolService>[0]
  );
  service.ensureThread({ threadId: THREAD_ID, transport: "sse-http" });
  return { service, puts };
};

describe("run.start langsmith_tracer", () => {
  it.each([
    {
      name: "tracer present, config present",
      params: {
        config: { configurable: { model: "gpt-4o" }, tags: ["a"] },
        langsmith_tracer: TRACER,
      },
      expectedConfigurable: {
        model: "gpt-4o",
        langsmith_project: "my-project",
        langsmith_example_id: "ex-1",
        thread_id: THREAD_ID,
      },
      expectedTags: ["a"],
    },
    {
      name: "tracer present, config absent",
      params: { langsmith_tracer: TRACER },
      expectedConfigurable: {
        langsmith_project: "my-project",
        langsmith_example_id: "ex-1",
        thread_id: THREAD_ID,
      },
      expectedTags: undefined,
    },
    {
      name: "tracer absent, config present",
      params: { config: { configurable: { model: "gpt-4o" }, tags: ["a"] } },
      expectedConfigurable: { model: "gpt-4o", thread_id: THREAD_ID },
      expectedTags: ["a"],
    },
    {
      name: "tracer absent, config absent",
      params: {},
      expectedConfigurable: { thread_id: THREAD_ID },
      expectedTags: undefined,
    },
  ])("$name", async ({ params, expectedConfigurable, expectedTags }) => {
    const { service, puts } = createService();

    const response = await service.handleCommand(
      THREAD_ID,
      {
        id: 1,
        method: "run.start",
        params: { assistant_id: "agent", input: { messages: [] }, ...params },
      },
      undefined
    );

    expect(response).toMatchObject({ type: "success" });
    expect(puts).toHaveLength(1);
    expect(puts[0].config?.configurable).toEqual(expectedConfigurable);
    expect(puts[0].config?.tags).toEqual(expectedTags);
  });
});
