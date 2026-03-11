import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("async local storage initialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("waits for initialization before invoking runnables", async () => {
    const events: string[] = [];
    let initialized = false;
    let resolveInitialization: ((value: boolean) => void) | undefined;
    const initializationPromise = new Promise<boolean>((resolve) => {
      resolveInitialization = resolve;
    });

    vi.doMock("../setup/async_local_storage.js", () => ({
      isAsyncLocalStorageSingletonInitialized: vi.fn(() => initialized),
      initializeAsyncLocalStorageSingleton: vi.fn(() => {
        events.push("init-start");
        return initializationPromise.then((result) => {
          initialized = result;
          return result;
        });
      }),
    }));

    vi.spyOn(
      AsyncLocalStorageProviderSingleton,
      "runWithConfig"
    ).mockImplementation(async (_, callback) => {
      events.push("run");
      return callback();
    });

    // Import after mocking so RunnableCallable picks up the mocked ALS helpers.
    const { RunnableCallable } = await import("../utils.js");
    const runnable = new RunnableCallable<string, string>({
      name: "testRunnable",
      trace: false,
      recurse: false,
      func: async () => "ok",
    });

    const invocation = runnable.invoke("input");
    await Promise.resolve();

    expect(events).toEqual(["init-start"]);

    resolveInitialization?.(true);
    events.push("init-end");

    await expect(invocation).resolves.toBe("ok");
    expect(events).toEqual(["init-start", "init-end", "run"]);
  });
});
