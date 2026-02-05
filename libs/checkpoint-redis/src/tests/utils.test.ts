import { describe, it, expect } from "vitest";
import { escapeRediSearchTagValue } from "../utils.js";

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
