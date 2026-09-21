import { describe, expect, it } from "vitest";
import { mcpAppParts, type McpAppResource } from "./bindings.js";

const VIEW: McpAppResource = {
  uri: "ui://demo/view",
  mimeType: "text/html;profile=mcp-app",
  html: "<p>view</p>",
};

const APPS = { opens_app: VIEW };

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "ai",
  id: `ai-${id}`,
  tool_calls: [{ id, name, args }],
});

const result = (id: string, content: unknown[], structured?: unknown) => ({
  type: "tool",
  tool_call_id: id,
  content,
  artifact: structured === undefined ? null : { structured_content: structured },
});

describe("mcpAppParts", () => {
  it("finds the call that ships a UI", () => {
    const parts = mcpAppParts({ messages: [call("c1", "opens_app", { account: "A" })] }, APPS);

    expect(parts).toHaveLength(1);
    expect(parts[0].toolName).toBe("opens_app");
    expect(parts[0].toolCallId).toBe("c1");
    expect(parts[0].input).toEqual({ account: "A" });
    expect(parts[0].resource).toBe(VIEW);
  });

  it("drops every call with no app, so an ordinary thread renders nothing", () => {
    const parts = mcpAppParts({ messages: [call("c1", "search"), call("c2", "write_file")] }, APPS);

    expect(parts).toEqual([]);
  });

  it("resolves by tool NAME, which is what lets arguments stream", () => {
    // The name is on the call before the arguments are finished, so a map
    // known up front identifies the app in time to be streamed into.
    const parts = mcpAppParts({ messages: [call("c1", "opens_app")] }, { opens_app: VIEW });

    expect(parts[0].resource).toBe(VIEW);
  });

  it("anchors the app to the message that opened it, not to the result", () => {
    const parts = mcpAppParts({ messages: [call("c1", "opens_app")] }, APPS);

    expect(parts[0].messageId).toBe("ai-c1");
  });

  it("joins a result to its call by tool_call_id", () => {
    const parts = mcpAppParts(
      {
        messages: [
          call("c1", "opens_app"),
          result("c1", [{ type: "text", text: "ok" }], { total: 3 }),
        ],
      },
      APPS,
    );

    expect(parts[0].output).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { total: 3 },
    });
  });

  it("carries the structured half of the result, which is what views read", () => {
    // `content` alone hands an app a JSON string where it expected an object,
    // and every field it draws comes out undefined.
    const parts = mcpAppParts(
      { messages: [call("c1", "opens_app"), result("c1", [], { sleeves: [] })] },
      APPS,
    );

    expect(parts[0].output?.structuredContent).toEqual({ sleeves: [] });
  });

  it("is streaming only while a run is going and the result has not landed", () => {
    const pending = mcpAppParts({ messages: [call("c1", "opens_app")], isLoading: true }, APPS);
    expect(pending[0].streaming).toBe(true);

    const settled = mcpAppParts(
      { messages: [call("c1", "opens_app"), result("c1", [])], isLoading: true },
      APPS,
    );
    expect(settled[0].streaming).toBe(false);

    const idle = mcpAppParts({ messages: [call("c1", "opens_app")], isLoading: false }, APPS);
    expect(idle[0].streaming).toBe(false);
  });

  it("keeps several apps in the order their calls appear", () => {
    const parts = mcpAppParts(
      { messages: [call("c1", "opens_app"), call("c2", "opens_app")] },
      APPS,
    );

    expect(parts.map((p) => p.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("ignores a malformed call rather than rendering a frame for it", () => {
    const parts = mcpAppParts(
      { messages: [{ type: "ai", id: "x", tool_calls: [{ name: "opens_app" }, { id: "no-name" }] }] },
      APPS,
    );

    expect(parts).toEqual([]);
  });

  it("returns nothing for an empty thread", () => {
    expect(mcpAppParts({}, APPS)).toEqual([]);
    expect(mcpAppParts({ messages: [] }, APPS)).toEqual([]);
  });

  it("renders nothing when no apps are known yet", () => {
    // The resources are read on mount, so the first frames have an empty map.
    expect(mcpAppParts({ messages: [call("c1", "opens_app")] })).toEqual([]);
  });
});
