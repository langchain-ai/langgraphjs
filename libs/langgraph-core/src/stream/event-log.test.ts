import { describe, expect, it } from "vitest";
import { EventLog } from "./event-log.js";
import { collectIterator as collect } from "./test-utils.js";

describe("EventLog", () => {
  it("pushes items and iterates them in order", async () => {
    const log = new EventLog<number>();
    log.push(1);
    log.push(2);
    log.push(3);
    log.close();

    const items = await collect(log.iterate());
    expect(items).toEqual([1, 2, 3]);
  });

  it("supports multiple independent cursors", async () => {
    const log = new EventLog<string>();
    log.push("a");
    log.push("b");
    log.close();

    const items1 = await collect(log.iterate());
    const items2 = await collect(log.iterate());
    expect(items1).toEqual(["a", "b"]);
    expect(items2).toEqual(["a", "b"]);
  });

  it("close() causes iterators to end with done:true", async () => {
    const log = new EventLog<number>();
    log.push(1);
    log.close();

    const iter = log.iterate();
    const first = await iter.next();
    expect(first).toEqual({ value: 1, done: false });

    const second = await iter.next();
    expect(second.done).toBe(true);
  });

  it("fail(err) causes iterators to throw that error", async () => {
    const log = new EventLog<number>();
    log.push(1);
    const error = new Error("boom");
    log.fail(error);

    const iter = log.iterate();
    await iter.next(); // consume the buffered item

    await expect(iter.next()).rejects.toThrow("boom");
  });

  it("iterate(startAt) skips items before startAt", async () => {
    const log = new EventLog<number>();
    log.push(10);
    log.push(20);
    log.push(30);
    log.close();

    const items = await collect(log.iterate(2));
    expect(items).toEqual([30]);
  });

  it("push after iterate starts delivers items to waiting cursors", async () => {
    const log = new EventLog<number>();
    const iter = log.iterate();

    const firstPromise = iter.next();

    log.push(42);
    const first = await firstPromise;
    expect(first).toEqual({ value: 42, done: false });

    log.push(43);
    log.close();

    const rest = await collect(iter);
    expect(rest).toEqual([43]);
  });

  it("toAsyncIterable works and returns independent iterators", async () => {
    const log = new EventLog<number>();
    log.push(1);
    log.push(2);
    log.close();

    const iterable = log.toAsyncIterable();

    const results1: number[] = [];
    for await (const item of iterable) {
      results1.push(item);
    }

    const results2: number[] = [];
    for await (const item of iterable) {
      results2.push(item);
    }

    expect(results1).toEqual([1, 2]);
    expect(results2).toEqual([1, 2]);
  });

  it("size reflects the number of pushed items", () => {
    const log = new EventLog<string>();
    expect(log.size).toBe(0);
    log.push("x");
    expect(log.size).toBe(1);
    log.push("y");
    expect(log.size).toBe(2);
  });

  it("done is false until close/fail", () => {
    const log = new EventLog<number>();
    expect(log.done).toBe(false);
    log.close();
    expect(log.done).toBe(true);
  });

  it("done is true after fail", () => {
    const log = new EventLog<number>();
    expect(log.done).toBe(false);
    log.fail(new Error("err"));
    expect(log.done).toBe(true);
  });

  it("concurrent push and iterate", async () => {
    const log = new EventLog<number>();
    const iter = log.iterate();
    const collected: number[] = [];

    const consumer = (async () => {
      for (;;) {
        const r = await iter.next();
        if (r.done) break;
        collected.push(r.value);
      }
    })();

    log.push(1);
    // Yield to let the consumer process
    await new Promise((r) => setTimeout(r, 0));
    log.push(2);
    await new Promise((r) => setTimeout(r, 0));
    log.push(3);
    log.close();

    await consumer;
    expect(collected).toEqual([1, 2, 3]);
  });

  it("toAsyncIterable respects startAt", async () => {
    const log = new EventLog<string>();
    log.push("a");
    log.push("b");
    log.push("c");
    log.close();

    const results: string[] = [];
    for await (const item of log.toAsyncIterable(1)) {
      results.push(item);
    }
    expect(results).toEqual(["b", "c"]);
  });

  it("get(index) returns the item at that position", () => {
    const log = new EventLog<string>();
    log.push("a");
    log.push("b");
    log.push("c");

    expect(log.get(0)).toBe("a");
    expect(log.get(1)).toBe("b");
    expect(log.get(2)).toBe("c");
  });

  it("get(index) throws RangeError for out-of-bounds", () => {
    const log = new EventLog<number>();
    log.push(1);

    expect(() => log.get(-1)).toThrow(RangeError);
    expect(() => log.get(1)).toThrow(RangeError);
    expect(() => log.get(100)).toThrow(RangeError);
  });

  it("get(index) throws RangeError on empty log", () => {
    const log = new EventLog<number>();
    expect(() => log.get(0)).toThrow(RangeError);
  });

  it("multiple cursors at different positions", async () => {
    const log = new EventLog<number>();
    log.push(0);
    log.push(1);
    log.push(2);
    log.push(3);
    log.close();

    const [from0, from2, from4] = await Promise.all([
      collect(log.iterate(0)),
      collect(log.iterate(2)),
      collect(log.iterate(4)),
    ]);

    expect(from0).toEqual([0, 1, 2, 3]);
    expect(from2).toEqual([2, 3]);
    expect(from4).toEqual([]);
  });
});
