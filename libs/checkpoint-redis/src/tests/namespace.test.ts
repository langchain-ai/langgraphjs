import { describe, expect, it } from "vitest";
import { hasDottedLabel, isWithinNamespace } from "../namespace.js";

describe("isWithinNamespace", () => {
  it.each([
    ["tenant.a", ["tenant", "a"], true],
    ["tenant.a.notes", ["tenant", "a"], true],
    ["tenant.ab", ["tenant", "a"], false],
    ["tenant.a-b", ["tenant", "a"], false],
    ["a.tenant", ["tenant", "a"], false],
    ["tenant.A", ["tenant", "a"], false],
    ["tenant", ["tenant", "a"], false],
    ["tenant", [""], false],
    ["anything.at.all", [], true],
  ])("%s in %j is %s", (prefix, namespace, expected) => {
    expect(isWithinNamespace(prefix, namespace)).toBe(expected);
  });
});

describe("hasDottedLabel", () => {
  it("finds a label containing the separator, including a number's", () => {
    expect(hasDottedLabel(["a.b"])).toBe(true);
    expect(hasDottedLabel(["a", "b.c"])).toBe(true);
    expect(hasDottedLabel([1.5] as unknown as string[])).toBe(true);
    expect(hasDottedLabel(["a", "b"])).toBe(false);
    expect(hasDottedLabel([123] as unknown as string[])).toBe(false);
    expect(hasDottedLabel([])).toBe(false);
  });
});
