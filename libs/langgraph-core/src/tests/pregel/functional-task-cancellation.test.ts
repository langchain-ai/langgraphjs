import { expect, it } from "vitest";
import { entrypoint, task } from "../../web.js";

it.each([false, true])(
  "does not retry a called task after cancellation (nested: %s)",
  async (nested) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let attempts = 0;
    let called!: Promise<unknown>;
    const operation = task(
      {
        name: "operation",
        retry: {
          maxAttempts: 3,
          initialInterval: 0,
          jitter: false,
          logWarning: false,
          retryOn: () => true,
        },
      },
      async () => {
        attempts += 1;
        started();
        await release;
        throw new Error("operation failed");
      }
    );
    const start = async () => {
      called = operation();
      return called;
    };
    const parent = task("parent", start);
    const workflow = entrypoint({ name: "workflow" }, async () =>
      nested ? parent() : start()
    );
    const controller = new AbortController();
    const run = workflow
      .invoke({}, { signal: controller.signal })
      .catch((error) => error);
    await ready;
    controller.abort();
    finish();
    await called.catch(() => undefined);
    expect(await run).toBeInstanceOf(Error);
    expect(attempts).toBe(1);
  }
);

it("still retries a called task while its run is active", async () => {
  let attempts = 0;
  const operation = task(
    {
      name: "operation",
      retry: {
        maxAttempts: 3,
        initialInterval: 0,
        jitter: false,
        logWarning: false,
        retryOn: () => true,
      },
    },
    async () => {
      if (++attempts < 3) throw new Error("temporary failure");
      return "done";
    }
  );
  const workflow = entrypoint({ name: "workflow" }, async () => operation());
  await expect(
    workflow.invoke({}, { signal: new AbortController().signal })
  ).resolves.toBe("done");
  expect(attempts).toBe(3);
});
