import { describe, expect, it } from "vitest";

import { HttpAgentServerAdapter } from "./agent-server.js";
import {
  createFetchRecorder,
  createWebSocketUrlRecorder,
} from "./test-helpers.js";

describe("HttpAgentServerAdapter hydration", () => {
  it("exposes getState for the default SSE delegate", async () => {
    const { fetch } = createFetchRecorder({
      response: new Response(
        JSON.stringify({ values: { messages: [] }, next: [], tasks: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    });
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:4100/api",
      threadId: "thread-1",
      fetch,
    });

    expect(adapter.getState).toEqual(expect.any(Function));
    await expect(adapter.getState?.()).resolves.toEqual({
      values: { messages: [] },
      next: [],
      tasks: [],
    });
  });

  it("omits getState for WebSocket delegates", () => {
    const { webSocketFactory } = createWebSocketUrlRecorder();
    const adapter = new HttpAgentServerAdapter({
      apiUrl: "http://localhost:4100/api",
      threadId: "thread-1",
      webSocketFactory,
    });

    expect(adapter.getState).toBeUndefined();
  });
});
