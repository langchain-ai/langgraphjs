// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";

import {
  generatedIdentifier,
  validateIdentifier,
} from "../store/identifiers.js";
import { getTextAtPath, jsonValueExpression } from "../store/json-path.js";
import {
  decodeStoreKey,
  encodeStoreKey,
  escapeLike,
  hasNamespacePrefix,
  matchesNamespaceCondition,
  namespacePath,
  namespacePrefixLikePattern,
  validateNamespace,
} from "../store/namespace.js";

describe("Oracle store helper modules", () => {
  test("formats namespace paths and prefix matching helpers", () => {
    expect(namespacePath(["team", "alpha"])).toBe('["team","alpha"]');
    expect(namespacePrefixLikePattern(["team"])).toBe('["team",%');
    expect(hasNamespacePrefix(["team", "alpha"], ["team"])).toBe(true);
    expect(hasNamespacePrefix(["team"], ["team", "alpha"])).toBe(false);
    expect(hasNamespacePrefix(["other", "alpha"], ["team"])).toBe(false);
  });

  test("rejects namespaces that BaseStore cannot safely persist", () => {
    expect(() => validateNamespace([])).toThrow("Namespace cannot be empty.");
    expect(() => validateNamespace(["langgraph"])).toThrow(
      'Root label for namespace cannot be "langgraph".'
    );
    expect(() => validateNamespace(["team.alpha"])).toThrow(
      "Namespace labels cannot contain periods"
    );
    expect(() => validateNamespace([""])).toThrow(
      "Namespace labels cannot be empty strings"
    );
    expect(() => validateNamespace(["team", 1 as never])).toThrow(
      "Namespace labels must be strings"
    );
  });

  test("matches namespace prefix and suffix conditions with wildcards", () => {
    expect(
      matchesNamespaceCondition(["team", "alpha", "profile"], {
        matchType: "prefix",
        path: ["team", "*"],
      })
    ).toBe(true);
    expect(
      matchesNamespaceCondition(["team", "alpha", "profile"], {
        matchType: "suffix",
        path: ["*", "profile"],
      })
    ).toBe(true);
    expect(
      matchesNamespaceCondition(["team"], {
        matchType: "suffix",
        path: ["team", "profile"],
      })
    ).toBe(false);
    expect(
      matchesNamespaceCondition(["team", "alpha"], {
        matchType: "suffix",
        path: ["beta"],
      })
    ).toBe(false);
  });

  test("escapes SQL LIKE wildcards in namespace prefixes", () => {
    expect(escapeLike("docs_%\\archive")).toBe("docs\\_\\%\\\\archive");
    const escapedPrefix = namespacePrefixLikePattern(["docs_%"]);
    expect(escapedPrefix).toContain("\\_");
    expect(escapedPrefix).toContain("\\%");
  });

  test("round-trips store keys without sentinel collisions", () => {
    expect(encodeStoreKey("")).toBe("b64:");
    expect(decodeStoreKey(encodeStoreKey(""))).toBe("");
    expect(decodeStoreKey(encodeStoreKey("b64:abc"))).toBe("b64:abc");
    expect(decodeStoreKey(encodeStoreKey("plain/key"))).toBe("plain/key");
    expect(decodeStoreKey("legacy-key")).toBe("legacy-key");
  });

  test("validates and generates Oracle identifiers within length limits", () => {
    expect(validateIdentifier("demo_store$1")).toBe("DEMO_STORE$1");
    expect(() => validateIdentifier("1bad")).toThrow(
      /Invalid Oracle identifier/
    );

    const generated = generatedIdentifier(`${"a".repeat(140)}_idx`);
    expect(Buffer.byteLength(generated, "utf8")).toBeLessThanOrEqual(128);
    expect(generated).toMatch(/^A+_[A-F0-9]{8}$/);
  });

  test("extracts JSON path text and JSON_VALUE expressions", () => {
    const value = {
      title: "root",
      nested: { count: 3 },
      items: [
        { text: "first", tags: ["a"] },
        { text: "second", tags: ["b"] },
      ],
      aliases: {
        primary: { text: "first alias" },
        secondary: { text: "second alias" },
      },
    };

    expect(getTextAtPath(value, "")).toEqual([JSON.stringify(value, null, 2)]);
    expect(getTextAtPath(value, "$")).toEqual([JSON.stringify(value, null, 2)]);
    expect(getTextAtPath(value, "nested.count")).toEqual(["3"]);
    expect(getTextAtPath(value, "nested")).toEqual([
      JSON.stringify({ count: 3 }, null, 2),
    ]);
    expect(getTextAtPath(value, "items[-1].text")).toEqual(["second"]);
    expect(new Set(getTextAtPath(value, "items[*].{text,tags[0]}"))).toEqual(
      new Set(["first", "second", "a", "b"])
    );
    expect(new Set(getTextAtPath(value, "aliases.*.text"))).toEqual(
      new Set(["first alias", "second alias"])
    );
    expect(getTextAtPath(value, "nested.count[0]")).toEqual([]);
    expect(getTextAtPath(value, "nested.count.*")).toEqual([]);
    expect(getTextAtPath(value, "items[bad].text")).toEqual([]);
    expect(getTextAtPath(value, "items[1.5].text")).toEqual([]);
    expect(getTextAtPath(value, "items[1oops].text")).toEqual([]);

    expect(jsonValueExpression("nested.count", "number", "s.item_value")).toBe(
      'JSON_VALUE(s.item_value, \'$."nested"."count"\' RETURNING NUMBER NULL ON ERROR)'
    );
    expect(jsonValueExpression("not-valid[0]")).toBeUndefined();
    expect(jsonValueExpression("nested.1bad")).toBeUndefined();
  });
});
