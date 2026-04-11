import { describe, expect, it } from "vitest";

import { Client } from "./index.js";
import { ProtocolClient } from "./stream/index.js";

describe("Client", () => {
  it("exposes stream sub-client on main Client", () => {
    const client = new Client({ apiUrl: "http://localhost:9999", apiKey: null });

    expect(client.stream).toBeInstanceOf(ProtocolClient);
    expect(client.assistants).toBeDefined();
    expect(client.threads).toBeDefined();
    expect(client.runs).toBeDefined();
    expect(client.crons).toBeDefined();
    expect(client.store).toBeDefined();
  });
});
