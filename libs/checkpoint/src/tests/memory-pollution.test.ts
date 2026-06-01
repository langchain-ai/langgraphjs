import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Checkpoint } from "../base.js";
import { MemorySaver } from "../memory.js";
import { uuid6 } from "../id.js";

/**
 * MemorySaver keeps its checkpoint state in two nested plain objects
 * (`storage` and `writes`) and writes to them with bracket notation,
 * e.g. `this.storage[threadId][checkpointNamespace][checkpoint.id] = ...`.
 *
 * Without an explicit guard, a `threadId` of `"__proto__"` (or
 * `"constructor"`) traverses the prototype chain and the assignment
 * mutates `Object.prototype`. From that point every plain object in the
 * process inherits the injected property, which breaks `for...in` loops,
 * truthy short-circuits, and downstream serializers across unrelated
 * code paths. CWE-1321 (Prototype Pollution).
 *
 * The fix adds an `assertSafeStorageKey` chokepoint that is invoked at
 * every public entry that touches `storage` or `writes`. These tests pin
 * its behaviour for every input shape we expect at runtime, including a
 * cross-test assertion that `Object.prototype` is not actually mutated
 * even when an attempt slips through.
 */
describe("MemorySaver prototype-pollution guard", () => {
  // Capture Object.prototype shape before each test so that any pollution
  // a buggy run introduces is detected and reverted, rather than leaking
  // into subsequent tests in this process.
  let prototypeKeysSnapshot: string[];

  beforeEach(() => {
    prototypeKeysSnapshot = Object.getOwnPropertyNames(Object.prototype);
  });

  afterEach(() => {
    const after = Object.getOwnPropertyNames(Object.prototype);
    const leaked = after.filter((k) => !prototypeKeysSnapshot.includes(k));
    for (const key of leaked) {
      // Defensive cleanup so a regression here cannot silently corrupt
      // unrelated tests in the same vitest worker.
      // eslint-disable-next-line no-param-reassign
      delete (Object.prototype as Record<string, unknown>)[key];
    }
    expect(leaked).toEqual([]);
  });

  const makeCheckpoint = (id: string = uuid6(0)): Checkpoint => ({
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  });

  describe("put", () => {
    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s as thread_id",
      async (key) => {
        const saver = new MemorySaver();
        await expect(
          saver.put(
            { configurable: { thread_id: key, checkpoint_ns: "" } },
            makeCheckpoint(),
            { source: "input", step: 0, parents: {} },
            {}
          )
        ).rejects.toThrow(/would mutate Object\.prototype/);
      }
    );

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s as checkpoint_ns",
      async (key) => {
        const saver = new MemorySaver();
        await expect(
          saver.put(
            { configurable: { thread_id: "tenant-a", checkpoint_ns: key } },
            makeCheckpoint(),
            { source: "input", step: 0, parents: {} },
            {}
          )
        ).rejects.toThrow(/would mutate Object\.prototype/);
      }
    );

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s as checkpoint.id",
      async (key) => {
        const saver = new MemorySaver();
        await expect(
          saver.put(
            { configurable: { thread_id: "tenant-a", checkpoint_ns: "" } },
            makeCheckpoint(key),
            { source: "input", step: 0, parents: {} },
            {}
          )
        ).rejects.toThrow(/would mutate Object\.prototype/);
      }
    );

    it("rejects non-string thread_id with a precise diagnostic", async () => {
      const saver = new MemorySaver();
      await expect(
        saver.put(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { configurable: { thread_id: { foo: 1 } as any, checkpoint_ns: "" } },
          makeCheckpoint(),
          { source: "input", step: 0, parents: {} },
          {}
        )
      ).rejects.toThrow(/expected a string identifier \(got object\)/);
    });

    it("accepts the documented empty checkpoint_ns default", async () => {
      const saver = new MemorySaver();
      await expect(
        saver.put(
          { configurable: { thread_id: "tenant-a", checkpoint_ns: "" } },
          makeCheckpoint(),
          { source: "input", step: 0, parents: {} },
          {}
        )
      ).resolves.toBeDefined();
    });
  });

  describe("putWrites", () => {
    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s as task_id",
      async (key) => {
        const saver = new MemorySaver();
        const config = {
          configurable: {
            thread_id: "tenant-a",
            checkpoint_ns: "",
            checkpoint_id: uuid6(0),
          },
        };
        await expect(saver.putWrites(config, [], key)).rejects.toThrow(
          /would mutate Object\.prototype/
        );
      }
    );

    it("rejects non-string checkpoint_id (NoSQL-style payload)", async () => {
      const saver = new MemorySaver();
      await expect(
        saver.putWrites(
          {
            configurable: {
              thread_id: "tenant-a",
              checkpoint_ns: "",
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              checkpoint_id: { $ne: null } as any,
            },
          },
          [],
          "task-1"
        )
      ).rejects.toThrow(/expected a string identifier \(got object\)/);
    });
  });

  describe("deleteThread", () => {
    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s",
      async (key) => {
        const saver = new MemorySaver();
        await expect(saver.deleteThread(key)).rejects.toThrow(
          /would mutate Object\.prototype/
        );
      }
    );

    it("rejects an array thread_id with the precise diagnostic", async () => {
      const saver = new MemorySaver();
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        saver.deleteThread(["tenant-a"] as any)
      ).rejects.toThrow(/got array/);
    });
  });

  describe("read paths refuse to lookup pollution keys", () => {
    it("getTuple rejects __proto__ thread_id", async () => {
      const saver = new MemorySaver();
      await expect(
        saver.getTuple({
          configurable: { thread_id: "__proto__", checkpoint_ns: "" },
        })
      ).rejects.toThrow(/would mutate Object\.prototype/);
    });

    it("list rejects constructor thread_id", async () => {
      const saver = new MemorySaver();
      const generator = saver.list({
        configurable: { thread_id: "constructor", checkpoint_ns: "" },
      });
      await expect(generator.next()).rejects.toThrow(
        /would mutate Object\.prototype/
      );
    });
  });

  describe("Object.prototype integrity", () => {
    it("a rejected put leaves Object.prototype unchanged", async () => {
      // Belt-and-braces: even though the guard throws before the
      // assignment, this test confirms the bytecode-level invariant.
      const saver = new MemorySaver();
      try {
        await saver.put(
          { configurable: { thread_id: "__proto__", checkpoint_ns: "" } },
          makeCheckpoint(),
          { source: "input", step: 0, parents: {} },
          {}
        );
      } catch {
        // expected
      }

      // A fresh plain object must not inherit anything that wasn't there
      // before the call. The afterEach() check enforces this for every
      // test in this file; the explicit assertion below is a clear
      // documentation of intent.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const probe: Record<string, unknown> = {};
      expect("polluted" in probe).toBe(false);
      expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(
        prototypeKeysSnapshot
      );
    });
  });
});
