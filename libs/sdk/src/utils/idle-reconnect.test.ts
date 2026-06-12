import { describe, it, expect, vi, afterEach } from "vitest";
import { idleReconnectStream, StreamIdleTimeoutError } from "./stream.js";

const enc = new TextEncoder();
/** BytesLineDecoder emits lines without their trailing newline. */
const line = (s: string) => enc.encode(s);
const HEARTBEAT = line(": heartbeat");
const DATA = line('data: {"x":1}');

/**
 * Drain the readable in the background, resolving when the stream ends
 * (`done`) or rejects (idle-timeout error).
 */
function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{
  errored: boolean;
  error?: unknown;
}> {
  return (async () => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) return { errored: false };
      }
    } catch (error) {
      return { errored: true, error };
    }
  })();
}

describe("idleReconnectStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto: arms after two heartbeats and fires after ~3x the cadence of silence", async () => {
    vi.useFakeTimers();
    const ts = idleReconnectStream({ mode: "auto" });
    const writer = ts.writable.getWriter();
    const result = drain(ts.readable.getReader());

    await writer.write(HEARTBEAT); // t=0, first heartbeat (no cadence yet)
    await vi.advanceTimersByTimeAsync(5_000);
    await writer.write(HEARTBEAT); // t=5s → interval 5s → window 15s

    // 14s of silence: still alive.
    await vi.advanceTimersByTimeAsync(14_000);
    // Cross the 15s window.
    await vi.advanceTimersByTimeAsync(2_000);

    const res = await result;
    expect(res.errored).toBe(true);
    expect(res.error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((res.error as StreamIdleTimeoutError).idleTimeoutMs).toBe(15_000);
  });

  it("auto: stays dormant on a heartbeat-less stream even through long silence", async () => {
    vi.useFakeTimers();
    const ts = idleReconnectStream({ mode: "auto" });
    const writer = ts.writable.getWriter();
    const result = drain(ts.readable.getReader());

    await writer.write(DATA);
    // Long silence with no heartbeats ever observed → never arms.
    await vi.advanceTimersByTimeAsync(120_000);
    await writer.close();

    const res = await result;
    expect(res.errored).toBe(false);
  });

  it("auto: heartbeats every 5s keep a quiet stream alive indefinitely", async () => {
    vi.useFakeTimers();
    const ts = idleReconnectStream({ mode: "auto" });
    const writer = ts.writable.getWriter();
    const result = drain(ts.readable.getReader());

    for (let i = 0; i < 20; i += 1) {
      await writer.write(HEARTBEAT);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await writer.close();

    const res = await result;
    expect(res.errored).toBe(false);
  });

  it("fixed: arms from the first byte and fires after the configured window", async () => {
    vi.useFakeTimers();
    const ts = idleReconnectStream({ mode: 10_000 });
    const result = drain(ts.readable.getReader());

    // No writes at all → fires at 10s.
    await vi.advanceTimersByTimeAsync(11_000);

    const res = await result;
    expect(res.errored).toBe(true);
    expect(res.error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((res.error as StreamIdleTimeoutError).idleTimeoutMs).toBe(10_000);
  });

  it("fixed: activity resets the window", async () => {
    vi.useFakeTimers();
    const ts = idleReconnectStream({ mode: 10_000 });
    const writer = ts.writable.getWriter();
    const result = drain(ts.readable.getReader());

    // A line every 8s keeps resetting the 10s window.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(8_000);
      await writer.write(DATA);
    }
    await writer.close();

    const res = await result;
    expect(res.errored).toBe(false);
  });
});
