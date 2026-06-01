import { describe, it, expect } from "vitest";
import {
  assertSafeKeyComponent,
  escapeRediSearchTagValue,
} from "../utils.js";

describe("escapeRediSearchTagValue", () => {
  it("should return placeholder for empty string", () => {
    expect(escapeRediSearchTagValue("")).toBe("__EMPTY_STRING__");
  });

  it("should escape backslashes", () => {
    expect(escapeRediSearchTagValue("foo\\bar")).toBe("foo\\\\bar");
  });

  it("should escape special characters", () => {
    // Test various special characters that need escaping
    expect(escapeRediSearchTagValue("hello-world")).toBe("hello\\-world");
    expect(escapeRediSearchTagValue("foo.bar")).toBe("foo\\.bar");
    expect(escapeRediSearchTagValue("test:value")).toBe("test\\:value");
    expect(escapeRediSearchTagValue("key=value")).toBe("key\\=value");
    expect(escapeRediSearchTagValue("a|b")).toBe("a\\|b");
    expect(escapeRediSearchTagValue("(test)")).toBe("\\(test\\)");
    expect(escapeRediSearchTagValue("{test}")).toBe("\\{test\\}");
    expect(escapeRediSearchTagValue("[test]")).toBe("\\[test\\]");
  });

  it("should escape spaces", () => {
    expect(escapeRediSearchTagValue("hello world")).toBe("hello\\ world");
  });

  it("should not modify strings without special characters", () => {
    expect(escapeRediSearchTagValue("simple")).toBe("simple");
    expect(escapeRediSearchTagValue("CamelCase")).toBe("CamelCase");
    expect(escapeRediSearchTagValue("under_score")).toBe("under_score");
  });

  it("should prevent RediSearch OR injection attempts", () => {
    // This is the attack payload that could escape thread boundaries
    const maliciousValue = "x}) | (@thread_id:{*";
    const escaped = escapeRediSearchTagValue(maliciousValue);

    // The escaped version should not contain unescaped special characters
    // that could break out of the TAG field context
    expect(escaped).toBe("x\\}\\)\\ \\|\\ \\(\\@thread_id\\:\\{\\*");

    // Verify no raw pipe, braces, or parentheses remain
    expect(escaped).not.toMatch(/(?<!\\)[|{}()]/);
  });

  it("should prevent RediSearch key injection attempts", () => {
    // Attempt to inject via key name
    const maliciousKey = "})|(@thread_id:{*})|(@x";
    const escaped = escapeRediSearchTagValue(maliciousKey);

    // Should escape all special characters
    expect(escaped).toBe("\\}\\)\\|\\(\\@thread_id\\:\\{\\*\\}\\)\\|\\(\\@x");
  });

  it("should handle multiple consecutive special characters", () => {
    expect(escapeRediSearchTagValue("{{}}")).toBe("\\{\\{\\}\\}");
    expect(escapeRediSearchTagValue("|||")).toBe("\\|\\|\\|");
    expect(escapeRediSearchTagValue("...")).toBe("\\.\\.\\.");
  });

  it("should handle mixed content", () => {
    expect(escapeRediSearchTagValue("user@example.com")).toBe(
      "user\\@example\\.com"
    );
    expect(escapeRediSearchTagValue("price: $100")).toBe("price\\:\\ \\$100");
  });
});

describe("assertSafeKeyComponent", () => {
  // Each method on RedisSaver / ShallowRedisSaver builds a Redis key by
  // string-interpolating identifiers from RunnableConfig.configurable. The
  // most severe sink is `deleteThread`, which feeds the value into
  // `client.keys(pattern)` followed by `client.del(...)`. A `threadId` of
  // `*` collapses the saver's per-tenant deletion into a database wipe.
  //
  // The guard below is the chokepoint that all entry points share. These
  // tests pin its behaviour on every input shape we expect at runtime.

  it("accepts a normal identifier", () => {
    expect(() =>
      assertSafeKeyComponent("thread_id", "tenant-a-thread-1")
    ).not.toThrow();
    expect(() =>
      assertSafeKeyComponent("checkpoint_id", "01HZX9V7EKJ1B0PNMY7MX3X3KB")
    ).not.toThrow();
  });

  it("accepts the documented empty checkpoint_ns when allowEmpty is set", () => {
    expect(() =>
      assertSafeKeyComponent("checkpoint_ns", "", { allowEmpty: true })
    ).not.toThrow();
  });

  it("rejects the empty string when allowEmpty is not set", () => {
    expect(() => assertSafeKeyComponent("thread_id", "")).toThrow(
      /empty string is not permitted/
    );
  });

  it("rejects the Redis glob wildcard `*` (the deleteThread wipe vector)", () => {
    expect(() => assertSafeKeyComponent("thread_id", "*")).toThrow(
      /Redis pattern meta-character/
    );
    // Even a single `*` anywhere in the value is rejected. This covers
    // patterns like `tenant-*` that would still expand to a glob.
    expect(() =>
      assertSafeKeyComponent("thread_id", "tenant-*")
    ).toThrow(/Redis pattern meta-character/);
  });

  it("rejects the Redis glob single-character `?`", () => {
    expect(() =>
      assertSafeKeyComponent("thread_id", "tenant-?")
    ).toThrow(/Redis pattern meta-character/);
  });

  it("rejects the Redis glob character class `[ ]`", () => {
    expect(() =>
      assertSafeKeyComponent("thread_id", "tenant-[ab]")
    ).toThrow(/Redis pattern meta-character/);
  });

  it("rejects backslash (Redis pattern escape character)", () => {
    expect(() =>
      assertSafeKeyComponent("thread_id", "tenant\\a")
    ).toThrow(/Redis pattern meta-character/);
  });

  it("accepts a colon in checkpoint_ns (LangGraph subgraph namespace)", () => {
    // LangGraph builds subgraph / nested-graph namespaces as
    // `${name}${CHECKPOINT_NAMESPACE_END}${taskId}` joined by `|`, where
    // CHECKPOINT_NAMESPACE_END === ":". A real namespace therefore looks
    // like "agent:01HZX...|tool:01HZY...". The colon is only ever a literal
    // in the Redis key, so it must be accepted; rejecting it would throw on
    // every subgraph checkpoint.
    expect(() =>
      assertSafeKeyComponent("checkpoint_ns", "agent:01HZX9V7EKJ1B0PNMY7MX3X3KB", {
        allowEmpty: true,
      })
    ).not.toThrow();
    expect(() =>
      assertSafeKeyComponent(
        "checkpoint_ns",
        "agent:01HZX9V7EKJ1B0PNMY7MX3X3KB|tool:01HZX9V7EKJ1B0PNMY7MX3X3KC",
        { allowEmpty: true }
      )
    ).not.toThrow();
  });

  it("rejects an object value (NoSQL-style operator injection attempt)", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertSafeKeyComponent("thread_id", { $ne: null } as any)
    ).toThrow(/expected a string identifier/);
  });

  it("rejects an array value with the precise diagnostic", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertSafeKeyComponent("thread_id", ["a"] as any)
    ).toThrow(/got array/);
  });

  it("rejects null, undefined, number, boolean with precise diagnostics", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertSafeKeyComponent("thread_id", null as any)
    ).toThrow(/got null/);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertSafeKeyComponent("thread_id", undefined as any)
    ).toThrow(/got undefined/);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertSafeKeyComponent("thread_id", 42 as any)
    ).toThrow(/got number/);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertSafeKeyComponent("thread_id", true as any)
    ).toThrow(/got boolean/);
  });

  it("includes the field name in every error so callers can surface it", () => {
    expect(() =>
      assertSafeKeyComponent("checkpoint_id", "*")
    ).toThrow(/"checkpoint_id"/);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertSafeKeyComponent("task_id", { $gt: "" } as any)
    ).toThrow(/"task_id"/);
  });
});
