import { describe, expect, it } from "vitest";

import { Client } from "./index.js";
import { ThreadStream } from "./stream/index.js";

describe("Client", () => {
  it("exposes sub-clients on main Client", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    expect(client.assistants).toBeDefined();
    expect(client.threads).toBeDefined();
    expect(client.runs).toBeDefined();
    expect(client.crons).toBeDefined();
    expect(client.store).toBeDefined();
  });

  it("threads.stream returns a ThreadStream bound to an existing thread ID", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    const thread = client.threads.stream("my-thread", {
      assistantId: "my-agent",
    });
    expect(thread).toBeInstanceOf(ThreadStream);
    expect(thread.threadId).toBe("my-thread");
    expect(thread.assistantId).toBe("my-agent");
  });

  it("threads.stream auto-generates a thread ID when called with options only", () => {
    const client = new Client({
      apiUrl: "http://localhost:9999",
      apiKey: null,
    });

    const thread = client.threads.stream({ assistantId: "my-agent" });
    expect(thread).toBeInstanceOf(ThreadStream);
    expect(thread.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(thread.assistantId).toBe("my-agent");
  });
});
