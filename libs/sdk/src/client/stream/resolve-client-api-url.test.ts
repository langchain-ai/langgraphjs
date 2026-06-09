import { describe, expect, it } from "vitest";

import { HttpAgentServerAdapter } from "./transport/agent-server.js";
import { resolveClientApiUrl } from "./resolve-client-api-url.js";

describe("resolveClientApiUrl", () => {
  it("prefers an explicit apiUrl", () => {
    const transport = new HttpAgentServerAdapter({
      apiUrl: "http://adapter:9000/api",
      threadId: "t1",
    });
    expect(
      resolveClientApiUrl({
        apiUrl: "http://explicit:8080/api",
        transport,
      })
    ).toBe("http://explicit:8080/api");
  });

  it("inherits apiUrl from HttpAgentServerAdapter", () => {
    const transport = new HttpAgentServerAdapter({
      apiUrl: "http://adapter:9000/api",
      threadId: "t1",
    });
    expect(resolveClientApiUrl({ transport })).toBe("http://adapter:9000/api");
  });

  it("returns undefined when no apiUrl is available", () => {
    expect(resolveClientApiUrl({ transport: "sse" })).toBeUndefined();
  });
});
