import { describe, expect, it } from "vitest";
import { StreamManager } from "../src/storage/ops.mjs";
import {
  RunCancellation,
  getCancelAction,
} from "../src/utils/cancellation.mjs";

describe("run cancellation reason", () => {
  it.each(["interrupt", "rollback"] as const)(
    "a %s abort carries the cancel marker",
    (action) => {
      const runId = `cancel-test-${action}`;
      const signal = StreamManager.lock(runId);
      try {
        StreamManager.getControl(runId)?.abort(action);
        expect(signal.reason).toBeInstanceOf(RunCancellation);
        expect(signal.reason.name).toBe("ExpectedCancellation");
        expect(getCancelAction(signal)).toBe(action);
      } finally {
        StreamManager.unlock(runId);
      }
    }
  );

  it("does not treat other aborts as a cancel", () => {
    const plain = new AbortController();
    plain.abort();
    expect(getCancelAction(plain.signal)).toBeUndefined();

    const timeout = new AbortController();
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    expect(getCancelAction(timeout.signal)).toBeUndefined();

    expect(getCancelAction(new AbortController().signal)).toBeUndefined();
  });
});
