import { describe, expect, test, vi } from "vitest";
import { effectScope, reactive } from "vue";
import { useControllableThreadId } from "../vue/thread.js";

describe("vue/useControllableThreadId", () => {
  test("uncontrolled: updates local threadId and calls callback", () => {
    const onThreadId = vi.fn();

    const scope = effectScope();
    const result = scope.run(() => {
      const [threadId, setThreadId] = useControllableThreadId({ onThreadId });
      return { threadId, setThreadId };
    });
    if (!result) throw new Error("Failed to create Vue effect scope.");

    expect(result.threadId.value).toBeNull();
    result.setThreadId("t1");
    expect(result.threadId.value).toBe("t1");
    expect(onThreadId).toHaveBeenCalledWith("t1");

    scope.stop();
  });

  test("controlled: reflects external reactive threadId; setThreadId only triggers callback", () => {
    const onThreadId = vi.fn();
    const opts = reactive<{
      threadId: string | null;
      onThreadId: (id: string) => void;
    }>({
      threadId: "t1",
      onThreadId,
    });

    const scope = effectScope();
    const result = scope.run(() => {
      const [threadId, setThreadId] = useControllableThreadId(opts);
      return { threadId, setThreadId };
    });
    if (!result) throw new Error("Failed to create Vue effect scope.");

    expect(result.threadId.value).toBe("t1");

    opts.threadId = "t2";
    expect(result.threadId.value).toBe("t2");

    result.setThreadId("t3");
    expect(onThreadId).toHaveBeenCalledWith("t3");
    // still controlled by opts.threadId
    expect(result.threadId.value).toBe("t2");

    scope.stop();
  });
});
