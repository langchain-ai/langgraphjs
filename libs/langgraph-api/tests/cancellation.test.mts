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

  it.each(["interrupt", "rollback"] as const)(
    "still accepts the legacy %s string reason",
    (action) => {
      const controller = new AbortController();
      controller.abort(action);
      expect(getCancelAction(controller.signal)).toBe(action);
    }
  );

  it("accepts a marker error from another copy of the class", () => {
    const controller = new AbortController();
    controller.abort(
      Object.assign(new Error("x"), {
        name: "ExpectedCancellation",
        action: "rollback",
      })
    );
    expect(getCancelAction(controller.signal)).toBe("rollback");
  });

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
