import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { useStream } from "./stream.js";
import type { StreamMode } from "../types.stream.js";
import type { Client } from "../client.js";

function createMockClient(): Client {
  return {
    threads: {
      getState: vi.fn().mockResolvedValue({
        values: { messages: [] },
        checkpoint: {
          thread_id: "t1",
          checkpoint_id: "cp1",
          checkpoint_ns: "",
          checkpoint_map: null,
        },
        next: [],
        tasks: [],
        metadata: undefined,
        created_at: null,
        parent_checkpoint: null,
      }),
      getHistory: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ thread_id: "t1" }),
    },
    runs: {
      stream: vi.fn().mockImplementation(
        async function* () {
          // no-op stream
        }
      ),
      joinStream: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({
        run_id: "run-1",
        created_at: new Date().toISOString(),
      }),
    },
  } as unknown as Client;
}

function mountThread(client: Client) {
  let thread:
    | ReturnType<typeof useStream<Record<string, unknown>>>
    | undefined;

  function Probe() {
    thread = useStream<Record<string, unknown>>({
      assistantId: "test-assistant",
      client,
      threadId: "t1",
      fetchStateHistory: false,
    });
    return null;
  }

  renderToString(<Probe />);
  if (thread == null) {
    throw new Error("Failed to mount stream handle.");
  }
  return thread;
}

it("does not evaluate guarded accessors during object spread", () => {
  const client = createMockClient();
  const thread = mountThread(client);

  expect(Object.prototype.propertyIsEnumerable.call(thread, "history")).toBe(
    false
  );
  expect(
    Object.prototype.propertyIsEnumerable.call(thread, "experimental_branchTree")
  ).toBe(false);

  expect(() => ({ ...thread })).not.toThrow();
  expect(() => thread.history).toThrow(
    "`fetchStateHistory` must be set to `true` to use `history`"
  );
});

it("does not auto-add tools/updates stream modes from spread", async () => {
  const client = createMockClient();
  const thread = mountThread(client);

  void { ...thread };

  await thread.submit({ messages: [] });

  const streamCall = (client.runs.stream as ReturnType<typeof vi.fn>).mock
    .calls[0]?.[2] as { streamMode?: StreamMode[] } | undefined;
  expect(streamCall?.streamMode).toBeDefined();
  expect(streamCall?.streamMode).not.toContain("tools");
  expect(streamCall?.streamMode).not.toContain("updates");
});

it("still opts into tools/updates when explicitly accessed", async () => {
  const client = createMockClient();
  const thread = mountThread(client);

  void thread.toolProgress;
  void (thread as unknown as { subagents: unknown }).subagents;

  await thread.submit({ messages: [] });

  const streamCall = (client.runs.stream as ReturnType<typeof vi.fn>).mock
    .calls[0]?.[2] as { streamMode?: StreamMode[] } | undefined;
  expect(streamCall?.streamMode).toContain("tools");
  expect(streamCall?.streamMode).toContain("updates");
});
