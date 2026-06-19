import { describe, it, expect } from "vitest";
import { validateNamespace } from "./utils.js";

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

  it("rejects the reserved 'langgraph' root label", () => {
    expect(() => validateNamespace(["langgraph", "users"])).toThrow(
      /Root label.*cannot be "langgraph"/
    );
  });

  // The block below covers the LIKE-wildcard cross-namespace leak. Search
  // operations match via `namespace_path LIKE ${prefix}%` (bound parameter),
  // and `%` / `_` / `\` in caller-supplied labels are still interpreted as
  // LIKE wildcards / escapes by Postgres regardless of binding. A namespace
  // prefix of `["%"]` would otherwise match every namespace in the store.
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
      // colon is the namespace path separator, hyphen / digit / unicode are fine
      expect(() =>
        validateNamespace(["tenant-1", "user:42", "プロジェクト"])
      ).not.toThrow();
    });
  });
});
