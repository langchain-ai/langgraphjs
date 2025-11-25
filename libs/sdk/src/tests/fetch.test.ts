import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

    describe("header coalescing", () => {
      it("should properly merge headers with conflicting name casing", async () => {
        const client = new Client({ apiKey: "test-api-key" });
        await (client.threads as any).fetch("/test", {
          headers: { "X-Api-Key": "custom-value" },
        });
        expect(expectedFetchMock).toHaveBeenCalledWith(
          expect.any(URL),
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
          expect.any(URL),
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
          expect.any(URL),
          expect.objectContaining({
            headers: expect.objectContaining({
              "x-api-key": "test-api-key",
              "x-default": "default-value",
            }),
          })
        );
        expect(expectedFetchMock).not.toHaveBeenCalledWith(
          expect.any(URL),
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
          expect.any(URL),
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
          expect.any(URL),
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
          expect.any(URL),
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
          expect.any(URL),
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
          expect.any(URL),
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
          expect.any(URL),
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
