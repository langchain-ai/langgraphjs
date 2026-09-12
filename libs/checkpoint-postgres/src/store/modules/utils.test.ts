import { describe, it, expect } from "vitest";
import {
  validateNamespace,
  namespaceScopeParams,
  namespaceScopeClause,
  namespaceMatchRegex,
} from "./utils.js";

describe("validateNamespace", () => {
  it("accepts a simple, well-formed namespace", () => {
    expect(() => validateNamespace(["tenants", "acme", "users"])).not.toThrow();
  });

  it("rejects empty namespace arrays", () => {
    expect(() => validateNamespace([])).toThrow(/cannot be empty/);
  });

  it("rejects empty string labels", () => {
    expect(() => validateNamespace(["tenants", ""])).toThrow(
      /cannot be empty strings/
    );
  });

  it("rejects labels containing periods", () => {
    expect(() => validateNamespace(["a.b"])).toThrow(/cannot contain periods/);
  });

  it("rejects labels containing colons (path separator)", () => {
    expect(() => validateNamespace(["a:b"])).toThrow(/cannot contain colons/);
    expect(() => validateNamespace(["tenant", "user:42"])).toThrow(
      /cannot contain colons/
    );
  });

  it("rejects the reserved 'langgraph' root label", () => {
    expect(() => validateNamespace(["langgraph", "users"])).toThrow(
      /Root label.*cannot be "langgraph"/
    );
  });

  // The block below covers the LIKE-wildcard cross-namespace leak. Search
  // operations used to match via `namespace_path LIKE ${prefix}%` (bound
  // parameter), and `%` / `_` / `\` in caller-supplied labels are still
  // interpreted as LIKE wildcards / escapes by Postgres regardless of
  // binding. A namespace prefix of `["%"]` would otherwise match every
  // namespace in the store.
  describe("LIKE wildcard / escape character rejection", () => {
    it.each([
      ["%"],
      ["_"],
      ["\\"],
      ["acme%"],
      ["acme_users"],
      ["acme\\users"],
      ["users", "%"],
    ])("rejects namespace with LIKE-special label %j", (...labels) => {
      expect(() => validateNamespace(labels)).toThrow(
        /SQL LIKE wildcards.*backslash/
      );
    });

    it("does not reject benign characters that look similar", () => {
      expect(() =>
        validateNamespace(["tenant-1", "プロジェクト"])
      ).not.toThrow();
    });
  });
});

describe("namespaceScopeParams / namespaceScopeClause", () => {
  it("builds exact-or-descendant params for a prefix", () => {
    expect(namespaceScopeParams(["tenant", "acme"])).toEqual({
      exact: "tenant:acme",
      like: "tenant:acme:%",
    });
    expect(namespaceScopeClause("namespace_path", 1)).toEqual({
      clause: "(namespace_path = $1 OR namespace_path LIKE $2)",
      nextIndex: 3,
    });
  });

  it("builds exact-or-ancestor params for a suffix", () => {
    expect(namespaceScopeParams(["alice"], "suffix")).toEqual({
      exact: "alice",
      like: "%:alice",
    });
  });

  it("does not let 'acme' also match 'acme-corp'", () => {
    const { exact, like } = namespaceScopeParams(["tenant", "acme"]);
    expect(exact).toBe("tenant:acme");
    expect("tenant:acme-corp".startsWith(exact)).toBe(true);
    expect("tenant:acme-corp".startsWith(like.slice(0, -1))).toBe(false);
    expect("tenant:acme:child".startsWith("tenant:acme:")).toBe(true);
  });
});

describe("namespaceMatchRegex", () => {
  it("anchors prefix matches on segment boundaries", () => {
    const pattern = namespaceMatchRegex(["foo"], "prefix");
    expect(pattern).toBe("^foo(:|$)");
    expect(new RegExp(pattern).test("foo")).toBe(true);
    expect(new RegExp(pattern).test("foo:child")).toBe(true);
    expect(new RegExp(pattern).test("foobar")).toBe(false);
    expect(new RegExp(pattern).test("foo2")).toBe(false);
  });

  it("anchors suffix matches on segment boundaries", () => {
    const pattern = namespaceMatchRegex(["alice"], "suffix");
    expect(new RegExp(pattern).test("uid:users:alice")).toBe(true);
    expect(new RegExp(pattern).test("alice")).toBe(true);
    expect(new RegExp(pattern).test("uid:users:malice")).toBe(false);
  });

  it("lets * span exactly one segment", () => {
    const pattern = namespaceMatchRegex(["uid", "*", "alice"], "prefix");
    const re = new RegExp(pattern);
    expect(re.test("uid:users:alice")).toBe(true);
    expect(re.test("uid:users:alice:extra")).toBe(true);
    expect(re.test("uid:a:b:alice")).toBe(false);
  });
});
