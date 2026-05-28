import { describe, expect, it } from "vitest";

import { MultiCursorBuffer } from "./multi-cursor-buffer.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

describe("MultiCursorBuffer", () => {
  it("replays buffered items to late consumers", async () => {
    const buffer = new MultiCursorBuffer<string>();
    buffer.push("one");
    buffer.push("two");
    buffer.close();

    await expect(collect(buffer)).resolves.toEqual(["one", "two"]);
    await expect(collect(buffer)).resolves.toEqual(["one", "two"]);
    expect(buffer.length).toBe(2);
  });

  it("keeps independent cursors for each iterator", async () => {
    const buffer = new MultiCursorBuffer<number>();
    buffer.push(1);
    buffer.push(2);

    const first = buffer[Symbol.asyncIterator]();
    const second = buffer[Symbol.asyncIterator]();

    await expect(first.next()).resolves.toEqual({ done: false, value: 1 });
    await expect(first.next()).resolves.toEqual({ done: false, value: 2 });
    await expect(second.next()).resolves.toEqual({ done: false, value: 1 });

    buffer.push(3);
    buffer.close();

    await expect(first.next()).resolves.toEqual({ done: false, value: 3 });
    await expect(first.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(second.next()).resolves.toEqual({ done: false, value: 2 });
    await expect(second.next()).resolves.toEqual({ done: false, value: 3 });
    await expect(second.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("waits for items pushed after next is requested", async () => {
    const buffer = new MultiCursorBuffer<string>();
    const iterator = buffer[Symbol.asyncIterator]();

    let resolved = false;
    const pending = iterator.next().then((result) => {
      resolved = true;
      return result;
    });

    await flush();
    expect(resolved).toBe(false);

    buffer.push("later");

    await expect(pending).resolves.toEqual({ done: false, value: "later" });
    expect(resolved).toBe(true);
  });

  it("resolves pending iterators when closed", async () => {
    const buffer = new MultiCursorBuffer<string>();
    const iterator = buffer[Symbol.asyncIterator]();

    const pending = iterator.next();
    buffer.close();

    await expect(pending).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("drains buffered items before completing after close", async () => {
    const buffer = new MultiCursorBuffer<string>();
    buffer.push("before-close");
    buffer.close();

    const iterator = buffer[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "before-close",
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
