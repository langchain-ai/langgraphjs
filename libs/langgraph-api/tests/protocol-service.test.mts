import { describe, expect, it, vi } from "vitest";

import { ProtocolService } from "../src/protocol/service.mjs";
import type { ProtocolCommand } from "../src/protocol/types.mjs";
import type { Run, RunsRepo } from "../src/storage/types.mjs";

const THREAD_ID = "00000000-0000-7000-8000-000000000099";
const INTERRUPT_ID = "4b704fd4b473bfd68df40c9979bffe1b";

const createRun = (): Run =>
  ({
    run_id: "00000000-0000-7000-8000-000000000001",
    thread_id: THREAD_ID,
    assistant_id: "assistant-1",
    created_at: new Date("2026-04-01T00:00:00.000Z"),
    updated_at: new Date("2026-04-01T00:00:00.000Z"),
    status: "pending",
    metadata: {},
    multitask_strategy: "reject",
    kwargs: {
      config: { configurable: { thread_id: THREAD_ID } },
      resumable: true,
    },
  }) satisfies Run;

describe("ProtocolService input.respond", () => {
  it("forwards config and metadata into the resumed run", async () => {
    const runsPut = vi.fn<RunsRepo["put"]>(async () => [createRun()]);
    const bindings = {
      runs: {
        get: vi.fn(async () => null),
        put: runsPut,
        stream: { join: vi.fn() },
      },
      threads: {
        state: {
          get: vi.fn(async () => ({
            tasks: [{ interrupts: [{ id: INTERRUPT_ID }] }],
            values: {},
            config: { configurable: { thread_id: THREAD_ID } },
          })),
        },
      },
    };

    const service = new ProtocolService(bindings as never);
    vi.spyOn(
      service as unknown as { ensureRunSession: () => Promise<void> },
      "ensureRunSession"
    ).mockResolvedValue(undefined);

    const record = service.ensureThread({
      threadId: THREAD_ID,
      transport: "sse-http",
    });
    record.assistantId = "test-graph";

    const response = await service.handleCommand(
      THREAD_ID,
      {
        id: 1,
        method: "input.respond",
        params: {
          interrupt_id: INTERRUPT_ID,
          response: { toolu_01A: { success: true } },
          namespace: ["sub-1"],
        },
      }
    );

    expect(response).toMatchObject({ type: "success" });
    expect(runsPut).toHaveBeenCalledOnce();

    const [, , kwargs, options] = runsPut.mock.calls[0]!;

    expect(kwargs.command).toEqual({
      resume: {
        [INTERRUPT_ID]: { toolu_01A: { success: true } },
      },
    });
    expect(kwargs.config?.configurable).toMatchObject({
      thread_id: THREAD_ID,
      tag: "resume",
    });
    expect(options.metadata).toEqual({ user_id: "u-1" });
  });
});
