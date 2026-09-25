import { describe, expect, it } from "vitest";
import {
  allOf,
  isWithinNamespace,
  joinsUnambiguously,
  prefixTextQuery,
  prefixWildcardQuery,
} from "../namespace.js";

describe("isWithinNamespace", () => {
  it.each([
    ["tenant.a", ["tenant", "a"], true],
    ["tenant.a.notes", ["tenant", "a"], true],
    ["tenant.ab", ["tenant", "a"], false],
    ["tenant.a-b", ["tenant", "a"], false],
    ["a.tenant", ["tenant", "a"], false],
    ["tenant.A", ["tenant", "a"], false],
    ["tenant", ["tenant", "a"], false],
    ["anything.at.all", [], true],
  ])("%s in %j is %s", (prefix, namespace, expected) => {
    expect(isWithinNamespace(prefix, namespace)).toBe(expected);
  });
});

describe("joinsUnambiguously", () => {
  it("rejects a label that is empty or contains the separator", () => {
    expect(joinsUnambiguously(["a.b"])).toBe(false);
    expect(joinsUnambiguously([""])).toBe(false);
    expect(joinsUnambiguously(["a", ""])).toBe(false);
    expect(joinsUnambiguously(["a", "b"])).toBe(true);
    expect(joinsUnambiguously([])).toBe(true);
    expect(joinsUnambiguously([1, 2] as unknown as string[])).toBe(false);
  });
});

describe("the earlier text queries", () => {
  it("are unchanged", () => {
    expect(prefixTextQuery(["tenant", "a-b"])).toBe("@prefix:(tenant a b)");
    expect(prefixTextQuery([])).toBe("*");
    expect(prefixWildcardQuery(["tenant-x", "a"])).toBe("@prefix:tenant*");
    expect(prefixWildcardQuery([])).toBe("*");
  });
});

describe("allOf", () => {
  it("drops clauses that match everything", () => {
    expect(allOf("@a:{x}", "@key:{k}")).toBe("(@a:{x}) (@key:{k})");
    expect(allOf("*", "@key:{k}")).toBe("@key:{k}");
    expect(allOf("@prefix:(a b)", "*")).toBe("@prefix:(a b)");
    expect(allOf("*", "*")).toBe("*");
  });
});
