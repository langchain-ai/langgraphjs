import { describe, expect, test } from "vitest";
import { inNamespaces } from "./namespaces.js";

describe("inNamespaces", () => {
  test("keeps every event when no namespace was asked for", () => {
    expect(inNamespaces(undefined)).toBeUndefined();
    expect(inNamespaces([])).toBeUndefined();
  });

  // The Agent Server's own filter cases (Go `buildNamespaceFilter`), for the
  // chat (`""`) and for a subagent's panel (`tools:a`).
  test.each([
    [[""], "values", undefined, true],
    [[""], "values|agent:x", undefined, true],
    [[""], "messages|tools:a", undefined, false],
    [[""], "values|tools:a|model:x", undefined, false],
    [[""], "messages|agent:x|tools:b", undefined, false],
    [[""], "values|toolsx:a", undefined, true],
    [[""], "values|task:a", undefined, true],
    [[""], "custom:redaction|tools:a", undefined, false],
    [[""], "messages/partial", undefined, true],
    [[""], "lifecycle|tools:a", undefined, true],
    [[""], "lifecycle|tools:a|tools:b", undefined, true],
    [[""], "metadata", undefined, true],
    [[""], "error", undefined, true],
    [[""], "end", undefined, true],
    [[""], "feedback", undefined, true],
    [[""], "interrupts", undefined, true],
    [[""], "gap", { reason: "too_large", mode: "messages|tools:a" }, false],
    [[""], "gap", { reason: "too_large", mode: "values" }, true],
    [[""], "gap", { reason: "expired" }, true],
    [["tools:a"], "values", undefined, false],
    [["tools:a"], "messages|tools:a", undefined, true],
    [["tools:a"], "values|tools:a|model:x", undefined, true],
    [["tools:a"], "messages|tools:a|1", undefined, true],
    [["tools:a"], "messages|tools:ab", undefined, false],
    [["tools:a"], "messages|tools:a|tools:b", undefined, false],
    [["tools:a"], "lifecycle|tools:a", undefined, false],
    [["tools:a"], "lifecycle|tools:a|tools:b", undefined, true],
    [["tools:a", "tools:b"], "messages|tools:b", undefined, true],
  ])("%j keeps %s (%j): %s", (namespaces, event, data, kept) => {
    expect(inNamespaces(namespaces)?.({ event, data })).toBe(kept);
  });
});
