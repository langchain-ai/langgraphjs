import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStream } from "./stream.js";
import type { Client } from "../client.js";

const failingRun = () =>
  (async function* () {
    yield { event: "error", data: { message: "boom" } };
  })();

// No DOM in this package's tests: a server render runs the hook once, which
// is enough to call submit, but the returned state never updates.
function renderStream(options: Record<string, unknown>) {
  let stream!: ReturnType<typeof useStream>;
  function Probe() {
    stream = useStream({ assistantId: "agent", ...options });
    return null;
  }
  renderToString(<Probe />);
  return stream;
}

describe("useStream submit onError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const boom = expect.objectContaining({ message: "boom" });

  it("calls the submit's onError and the hook's onError when a run fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = { run_id: "run-1", thread_id: "t1" };
    const client = {
      threads: { create: vi.fn().mockResolvedValue({ thread_id: "t1" }) },
      runs: {
        stream: vi.fn(
          (
            _threadId: string,
            _assistantId: string,
            payload: { onRunCreated: (created: typeof run) => void }
          ) => {
            payload.onRunCreated(run);
            return failingRun();
          }
        ),
      },
    };
    const hookOnError = vi.fn();
    const submitOnError = vi.fn();
    const stream = renderStream({
      client: client as unknown as Client,
      onError: hookOnError,
    });

    await stream.submit({ messages: [] }, { onError: submitOnError });

    expect(submitOnError).toHaveBeenCalledExactlyOnceWith(boom, run);
    expect(hookOnError).toHaveBeenCalledExactlyOnceWith(boom, run);
  });

  it("calls the submit's onError and the hook's onError when a custom transport run fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hookOnError = vi.fn();
    const submitOnError = vi.fn();
    const stream = renderStream({
      transport: { stream: async () => failingRun() },
      onError: hookOnError,
    });

    await stream.submit({ messages: [] }, { onError: submitOnError });

    expect(submitOnError).toHaveBeenCalledExactlyOnceWith(boom, undefined);
    expect(hookOnError).toHaveBeenCalledExactlyOnceWith(boom, undefined);
  });
});
