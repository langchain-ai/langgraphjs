import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  coerceMessageLikeToMessage,
} from "@langchain/core/messages";
import { Client } from "../client.js";
import { overrideFetchImplementation } from "../singletons/fetch.js";
import * as envUtils from "../utils/env.js";

describe.each([["global"], ["mocked"]])(
  "Client uses %s fetch",
  (description: string) => {
    let globalFetchMock: ReturnType<typeof vi.fn>;
    let overriddenFetch: ReturnType<typeof vi.fn>;

    let expectedFetchMock: ReturnType<typeof vi.fn>;
    let unexpectedFetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      globalFetchMock = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              batch_ingest_config: {
                use_multipart_endpoint: true,
              },
            }),
          text: () => Promise.resolve(""),
          headers: new Headers({}),
        })
      );
      overriddenFetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              batch_ingest_config: {
                use_multipart_endpoint: true,
              },
            }),
          text: () => Promise.resolve(""),
          headers: new Headers({}),
        })
      );
      expectedFetchMock =
        description === "mocked" ? overriddenFetch : globalFetchMock;
      unexpectedFetchMock =
        description === "mocked" ? globalFetchMock : overriddenFetch;

      if (description === "mocked") {
        overrideFetchImplementation(overriddenFetch);
      } else {
        overrideFetchImplementation(globalFetchMock);
      }
      // Mock global fetch
      (globalThis as any).fetch = globalFetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe("createRuns", () => {
      it("should create an example with the given input and generation", async () => {
        const client = new Client({ apiKey: "test-api-key" });

        const thread = await client.threads.create();
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        expect(unexpectedFetchMock).not.toHaveBeenCalled();

        vi.clearAllMocks(); // Clear all mocks before the next operation

        // Then clear & run the function
        await client.runs.create(thread.thread_id, "somegraph", {
          input: { foo: "bar" },
        });
        expect(expectedFetchMock).toHaveBeenCalledTimes(1);
        expect(unexpectedFetchMock).not.toHaveBeenCalled();
      });
    });

    describe("threads.update", () => {
      it("should request a minimal response when returnMinimal is true", async () => {
        expectedFetchMock.mockResolvedValueOnce({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          headers: new Headers({}),
        });

        const client = new Client({ apiKey: "test-api-key" });
        const result = await client.threads.update("thread_123", {
          metadata: { foo: "bar" },
          returnMinimal: true,
        });

        expect(result).toBeUndefined();
        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/threads/thread_123"),
          expect.objectContaining({
            method: "PATCH",
            headers: expect.objectContaining({
              prefer: "return=minimal",
            }),
          })
        );
        expect(
          JSON.parse((expectedFetchMock.mock.calls[0][1] as RequestInit).body as string)
        ).toEqual({ metadata: { foo: "bar" } });
        expect(unexpectedFetchMock).not.toHaveBeenCalled();
      });
    });

    describe("header coalescing", () => {
      it("should properly merge headers with conflicting name casing", async () => {
        const client = new Client({ apiKey: "test-api-key" });
        await (client.threads as any).fetch("/test", {
          headers: { "X-Api-Key": "custom-value" },
        });
        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "custom-value",
            }),
          })
        );
      });

      it("should properly merge headers from multiple sources", async () => {
        const client = new Client({
          apiKey: "test-api-key",
          defaultHeaders: {
            "x-default": "default-value",
            "x-override": "default-value",
          },
        });

        await (client.threads as any).fetch("/test", {
          headers: {
            "x-custom": "custom-value",
            "x-override": "custom-value",
          },
        });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-default": "default-value",
              "x-custom": "custom-value",
              "x-override": "custom-value",
            }),
          })
        );

        vi.clearAllMocks();

        // Test with null/undefined values
        await (client.threads as any).fetch("/test", {
          headers: {
            "x-null": null,
            "x-undefined": undefined,
            "x-empty": "",
          },
        });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-default": "default-value",
            }),
          })
        );
        expect(expectedFetchMock).not.toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-null": null,
              "x-undefined": undefined,
            }),
          })
        );
      });

      it("should handle Headers object input", async () => {
        const client = new Client({ apiKey: "test-api-key" });
        const headers = new Headers();
        headers.append("x-custom", "custom-value");
        headers.append("x-multi", "value1");
        headers.append("x-multi", "value2");

        await (client.threads as any).fetch("/test", { headers });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-custom": "custom-value",
              "x-multi": "value1, value2",
            }),
          })
        );
      });

      it("should handle array of header tuples", async () => {
        const client = new Client({
          apiKey: "test-api-key",
          defaultHeaders: {
            "x-custom": "custom-value",
          },
        });
        const headers = [
          ["x-multi", "value1"],
          ["x-multi", "value2"],
        ];

        await (client.threads as any).fetch("/test", { headers });

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-custom": "custom-value",
              "x-multi": "value1, value2",
            }),
          })
        );
      });
    });

    describe("API key auto-load", () => {
      it("should auto-load API key from environment when apiKey is undefined", async () => {
        const getEnvSpy = vi
          .spyOn(envUtils, "getEnvironmentVariable")
          .mockImplementation((name: string) => {
            if (name === "LANGGRAPH_API_KEY") return "env-api-key";
            return undefined;
          });

        const client = new Client();
        await (client.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenNthCalledWith(
          1,
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "env-api-key",
            }),
          })
        );

        const client2 = new Client({ apiKey: undefined });
        await (client2.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenNthCalledWith(
          2,
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "env-api-key",
            }),
          })
        );

        getEnvSpy.mockRestore();
      });

      it("should skip API key auto-load when apiKey is null", async () => {
        const getEnvSpy = vi
          .spyOn(envUtils, "getEnvironmentVariable")
          .mockImplementation((name: string) => {
            if (name === "LANGGRAPH_API_KEY") return "env-api-key";
            return undefined;
          });

        const client = new Client({ apiKey: null });
        await (client.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.not.objectContaining({
              "x-api-key": expect.anything(),
            }),
          })
        );

        getEnvSpy.mockRestore();
      });

      it("should use explicit API key when provided as a string", async () => {
        const getEnvSpy = vi
          .spyOn(envUtils, "getEnvironmentVariable")
          .mockImplementation((name: string) => {
            if (name === "LANGGRAPH_API_KEY") return "env-api-key";
            return undefined;
          });

        const client = new Client({
          apiKey: "explicit-api-key",
        });
        await (client.threads as any).fetch("/test");

        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "explicit-api-key",
            }),
          })
        );

        getEnvSpy.mockRestore();
      });
    });
  }
);

describe("Client BaseMessage normalization on outbound requests", () => {
  // The langgraph-api server used to revive ``{lc:1, type:"constructor", ...}``
  // envelopes via ``langchain_core.load.load`` to undo this very
  // ``JSON.stringify(BaseMessage)`` shape. That deserialization gadget was
  // removed (Corridor CWE-502 finding); the SDK now normalises to canonical
  // dicts on the way out so the wire shape never carries an envelope.
  let fetchMock: ReturnType<typeof vi.fn>;

  function captureBody(): unknown {
    const lastCall = fetchMock.mock.calls.at(-1);
    if (!lastCall) throw new Error("fetch was not called");
    const init = lastCall[1] as { body?: string };
    if (!init?.body) throw new Error("request had no body");
    return JSON.parse(init.body);
  }

  beforeEach(() => {
    fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        headers: new Headers({}),
      })
    );
    overrideFetchImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts a HumanMessage instance to a {type, content} dict", async () => {
    const client = new Client({ apiKey: "k" });
    await (client.threads as any).fetch("/test", {
      method: "POST",
      json: { input: { messages: [new HumanMessage("hi")] } },
    });
    const body = captureBody() as {
      input: { messages: Array<Record<string, unknown>> };
    };
    expect(body.input.messages).toEqual([{ type: "human", content: "hi" }]);
    // No envelope field should leak through.
    expect(body.input.messages[0]).not.toHaveProperty("lc");
    expect(body.input.messages[0]).not.toHaveProperty("kwargs");
  });

  it("preserves AIMessage tool_calls and additional metadata", async () => {
    const client = new Client({ apiKey: "k" });
    const msg = new AIMessage({
      content: "thinking",
      tool_calls: [
        {
          id: "tc-1",
          name: "search",
          args: { q: "weather" },
          type: "tool_call",
        },
      ],
      additional_kwargs: { custom: 1 },
    });
    await (client.threads as any).fetch("/test", {
      method: "POST",
      json: { input: { messages: [msg] } },
    });
    const body = captureBody() as {
      input: { messages: Array<Record<string, unknown>> };
    };
    expect(body.input.messages[0]).toMatchObject({
      type: "ai",
      content: "thinking",
      tool_calls: [
        {
          id: "tc-1",
          name: "search",
          args: { q: "weather" },
          type: "tool_call",
        },
      ],
      additional_kwargs: { custom: 1 },
    });
  });

  it("preserves ToolMessage tool_call_id", async () => {
    const client = new Client({ apiKey: "k" });
    const msg = new ToolMessage({
      content: "result",
      tool_call_id: "tc-1",
    });
    await (client.threads as any).fetch("/test", {
      method: "POST",
      json: { input: { messages: [msg] } },
    });
    const body = captureBody() as {
      input: { messages: Array<Record<string, unknown>> };
    };
    expect(body.input.messages[0]).toMatchObject({
      type: "tool",
      content: "result",
      tool_call_id: "tc-1",
    });
  });

  it("passes plain dicts through unchanged", async () => {
    const client = new Client({ apiKey: "k" });
    const dictPayload = {
      input: {
        messages: [{ type: "human", content: "already a dict" }],
        config: { tags: ["t"] },
      },
    };
    await (client.threads as any).fetch("/test", {
      method: "POST",
      json: dictPayload,
    });
    expect(captureBody()).toEqual(dictPayload);
  });

  it("normalises mixed arrays of instances and dicts", async () => {
    const client = new Client({ apiKey: "k" });
    await (client.threads as any).fetch("/test", {
      method: "POST",
      json: {
        input: {
          messages: [
            new SystemMessage("you are helpful"),
            { type: "human", content: "hi" },
            new AIMessage("hello"),
          ],
        },
      },
    });
    const body = captureBody() as {
      input: { messages: Array<Record<string, unknown>> };
    };
    expect(body.input.messages).toEqual([
      { type: "system", content: "you are helpful" },
      { type: "human", content: "hi" },
      { type: "ai", content: "hello" },
    ]);
  });

  it("normalises BaseMessage nested inside tool_calls.args", async () => {
    const client = new Client({ apiKey: "k" });
    const inner = new HumanMessage("inner");
    const msg = new AIMessage({
      content: "x",
      tool_calls: [
        { id: "t", name: "tool", args: { msg: inner }, type: "tool_call" },
      ],
    });
    await (client.threads as any).fetch("/test", {
      method: "POST",
      json: { input: { messages: [msg] } },
    });
    const body = captureBody() as {
      input: {
        messages: Array<{
          tool_calls: Array<{ args: { msg: Record<string, unknown> } }>;
        }>;
      };
    };
    const innerOnWire = body.input.messages[0].tool_calls[0].args.msg;
    expect(innerOnWire).toEqual({ type: "human", content: "inner" });
    expect(innerOnWire).not.toHaveProperty("lc");
    expect(innerOnWire).not.toHaveProperty("kwargs");
  });

  it("normalises BaseMessage nested inside additional_kwargs", async () => {
    const client = new Client({ apiKey: "k" });
    const memo = new SystemMessage("memo");
    const msg = new AIMessage({
      content: "x",
      additional_kwargs: { memo },
    });
    await (client.threads as any).fetch("/test", {
      method: "POST",
      json: { input: { messages: [msg] } },
    });
    const body = captureBody() as {
      input: {
        messages: Array<{ additional_kwargs: { memo: Record<string, unknown> } }>;
      };
    };
    expect(body.input.messages[0].additional_kwargs.memo).toEqual({
      type: "system",
      content: "memo",
    });
  });

  it("does not stack-overflow on cyclic POJOs", async () => {
    const client = new Client({ apiKey: "k" });
    const cyclic: Record<string, unknown> = { type: "human", content: "x" };
    cyclic.self = cyclic;
    // JSON.stringify would throw on a cyclic graph; the normalizer now
    // emits a sentinel and lets stringify succeed.
    await expect(
      (client.threads as any).fetch("/test", {
        method: "POST",
        json: { meta: cyclic },
      })
    ).resolves.toBeDefined();
    const body = captureBody() as { meta: Record<string, unknown> };
    expect(body.meta.self).toBe("[Circular]");
  });

  it("walks nested message arrays anywhere in the body", async () => {
    const client = new Client({ apiKey: "k" });
    await (client.threads as any).fetch("/test", {
      method: "POST",
      // ``command.update`` payloads can carry messages too — the
      // replacer walks the whole tree, so this works without enumerating
      // known field names.
      json: {
        command: {
          update: { messages: [new HumanMessage("nested")] },
        },
      },
    });
    const body = captureBody() as {
      command: { update: { messages: Array<Record<string, unknown>> } };
    };
    expect(body.command.update.messages).toEqual([
      { type: "human", content: "nested" },
    ]);
  });

  // The wire shape we emit on the way out is the same shape the JS server
  // receives on the way in. ``coerceMessageLikeToMessage`` (which the JS
  // server-side ``messagesStateReducer`` uses) is the canonical consumer
  // of canonical message dicts — round-tripping every standard subclass
  // through it locks the JS→JS contract: no class that worked under the
  // pre-PR envelope shape should fail under the post-PR canonical shape.
  describe("canonical dict round-trips through coerceMessageLikeToMessage", () => {
    async function dictForMessage(
      m: unknown
    ): Promise<Record<string, unknown>> {
      const client = new Client({ apiKey: "k" });
      await (client.threads as any).fetch("/test", {
        method: "POST",
        json: { messages: [m] },
      });
      const body = captureBody() as {
        messages: Array<Record<string, unknown>>;
      };
      return body.messages[0];
    }

    it("HumanMessage", async () => {
      const original = new HumanMessage({
        content: "hi",
        id: "h1",
        additional_kwargs: { custom: 1 },
      });
      const dict = await dictForMessage(original);
      const revived = coerceMessageLikeToMessage(dict as never);
      expect(HumanMessage.isInstance(revived)).toBe(true);
      expect(revived.content).toBe("hi");
      expect(revived.id).toBe("h1");
      expect(revived.additional_kwargs).toEqual({ custom: 1 });
    });

    it("AIMessage with tool_calls / invalid_tool_calls / usage_metadata", async () => {
      const original = new AIMessage({
        content: "thinking",
        tool_calls: [
          { id: "tc1", name: "search", args: { q: "x" }, type: "tool_call" },
        ],
        invalid_tool_calls: [
          {
            id: "tc2",
            name: "broken",
            args: "{not json",
            error: "parse failed",
            type: "invalid_tool_call",
          },
        ],
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      });
      const dict = await dictForMessage(original);
      const revived = coerceMessageLikeToMessage(dict as never) as AIMessage;
      expect(AIMessage.isInstance(revived)).toBe(true);
      expect(revived.content).toBe("thinking");
      expect(revived.tool_calls).toEqual(original.tool_calls);
      expect(revived.invalid_tool_calls).toEqual(original.invalid_tool_calls);
      expect(revived.usage_metadata).toEqual(original.usage_metadata);
    });

    it("AIMessageChunk emits tool_call_chunks on the wire", async () => {
      // ``_constructMessageFromParams`` routes both AIMessage and
      // AIMessageChunk to ``new AIMessage(rest)`` and AIMessage has no
      // ``tool_call_chunks`` field, so the server-side coercion drops
      // them on revival — pre-existing and unrelated to this PR. The
      // wire-level contract we're locking is just that the SDK doesn't
      // *silently* eat the field on the way out.
      const original = new AIMessageChunk({
        content: "partial",
        tool_call_chunks: [
          { id: "tc1", name: "search", args: '{"q":', index: 0 },
        ],
      });
      const dict = await dictForMessage(original);
      expect(dict.tool_call_chunks).toEqual(original.tool_call_chunks);
      expect(dict.type).toBe("ai");
    });

    it("SystemMessage", async () => {
      const original = new SystemMessage({
        content: "you are a helpful assistant",
        id: "s1",
      });
      const dict = await dictForMessage(original);
      const revived = coerceMessageLikeToMessage(dict as never);
      expect(SystemMessage.isInstance(revived)).toBe(true);
      expect(revived.content).toBe("you are a helpful assistant");
      expect(revived.id).toBe("s1");
    });

    it("ToolMessage with status / artifact", async () => {
      const original = new ToolMessage({
        content: "result body",
        tool_call_id: "tc-99",
        name: "search",
        status: "success",
        artifact: { extra: "payload" },
      });
      const dict = await dictForMessage(original);
      const revived = coerceMessageLikeToMessage(dict as never) as ToolMessage;
      expect(ToolMessage.isInstance(revived)).toBe(true);
      expect(revived.content).toBe("result body");
      expect(revived.tool_call_id).toBe("tc-99");
      expect(revived.name).toBe("search");
      expect(revived.status).toBe("success");
      expect(revived.artifact).toEqual({ extra: "payload" });
    });

    it("RemoveMessage", async () => {
      const original = new RemoveMessage({ id: "msg-to-delete" });
      const dict = await dictForMessage(original);
      const revived = coerceMessageLikeToMessage(dict as never);
      expect(RemoveMessage.isInstance(revived)).toBe(true);
      expect(revived.id).toBe("msg-to-delete");
    });
  });
});
