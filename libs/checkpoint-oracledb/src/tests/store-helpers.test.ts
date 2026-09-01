// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";

import {
  generatedIdentifier,
  validateIdentifier,
  suffixedTableName,
  validateTableSuffix,
} from "../identifiers.js";
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
    expect(namespacePath(["team", "alpha"])).toBe("team.alpha");
    expect(namespacePrefixLikePattern(["team"])).toBe("team.%");
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

  test("uses Python-compatible raw store keys", () => {
    expect(encodeStoreKey("")).toBe("");
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

    // Reference strings from CPython:
    //   json.dumps(value, sort_keys=True, ensure_ascii=False)
    // The embedded text has to match Python exactly, or the same document
    // produces different vectors in each language.
    const pythonRoot =
      '{"aliases": {"primary": {"text": "first alias"}, "secondary": ' +
      '{"text": "second alias"}}, "items": [{"tags": ["a"], "text": "first"}, ' +
      '{"tags": ["b"], "text": "second"}], "nested": {"count": 3}, ' +
      '"title": "root"}';

    expect(getTextAtPath(value, "")).toEqual([pythonRoot]);
    expect(getTextAtPath(value, "$")).toEqual([pythonRoot]);
    expect(getTextAtPath(value, "nested.count")).toEqual(["3"]);
    expect(getTextAtPath(value, "nested")).toEqual(['{"count": 3}']);
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

describe("Python embedding text parity", () => {
  test("renders booleans and non-ASCII the way Python does", () => {
    // CPython: json.dumps({"a": True, "b": "é"}, sort_keys=True, ensure_ascii=False)
    expect(getTextAtPath({ a: true, b: "é" }, "$")).toEqual([
      '{"a": true, "b": "é"}',
    ]);
    // Python str(True) is "True", not "true".
    expect(getTextAtPath({ flag: true }, "flag")).toEqual(["True"]);
    expect(getTextAtPath({ flag: false }, "flag")).toEqual(["False"]);
    expect(getTextAtPath({ n: 3 }, "n")).toEqual(["3"]);
    expect(getTextAtPath({ s: "text" }, "s")).toEqual(["text"]);
  });

  test("keeps non-ASCII unescaped, unlike the index configuration hash", () => {
    // get_text_at_path uses ensure_ascii=False; _generate_suffix does not.
    expect(getTextAtPath({ t: { x: "é" } }, "t")).toEqual(['{"x": "é"}']);
  });
});

describe("Oracle identifier quoting rules", () => {
  // We only ever emit unquoted identifiers, which Oracle folds to upper case
  // and restricts to [A-Za-z][A-Za-z0-9_$#]*. Anything that would require
  // double quoting has to be rejected, not silently quoted, or two callers
  // could disagree about which table they are addressing.
  test("folds unquoted identifiers to upper case", () => {
    expect(validateIdentifier("checkpoints")).toBe("CHECKPOINTS");
    expect(validateIdentifier("CheckPoints")).toBe("CHECKPOINTS");
    expect(validateIdentifier("CHECKPOINTS")).toBe("CHECKPOINTS");
  });

  test("resolves any casing of a suffix to one table name", () => {
    const names = ["memory", "MEMORY", "MeMoRy"].map(
      (suffix) => suffixedTableName("CHECKPOINTS", suffix)
    );
    expect(new Set(names)).toEqual(new Set(["CHECKPOINTS_MEMORY"]));
  });

  test("omits the separator when no suffix is given", () => {
    expect(suffixedTableName("CHECKPOINTS")).toBe("CHECKPOINTS");
    expect(suffixedTableName("CHECKPOINTS", "")).toBe("CHECKPOINTS");
  });

  test("rejects suffixes that would need double quoting", () => {
    for (const suffix of [
      'my"table', // embedded quote
      '"quoted"', // caller pre-quoting the name
      "my table", // space
      "my-table", // hyphen
      "my.table", // schema qualification
      "tenant;DROP TABLE CHECKPOINTS", // statement break
      "1memory", // leading digit
      "mémoire", // non-ASCII
      "memory$", // legal in an identifier, but not in a suffix
      "memory#",
    ]) {
      expect(() => validateTableSuffix(suffix)).toThrow(
        /must start with a letter/
      );
      expect(() => suffixedTableName("CHECKPOINTS", suffix)).toThrow(
        /must start with a letter/
      );
    }
  });

  test("rejects identifiers that would need double quoting", () => {
    for (const identifier of [
      'CHECK"POINTS',
      '"CHECKPOINTS"',
      "CHECK POINTS",
      "CHECK-POINTS",
      "CHECK.POINTS",
      "1CHECKPOINTS",
      "CHECKPOINTS; DROP TABLE X",
    ]) {
      expect(() => validateIdentifier(identifier)).toThrow(
        /Invalid Oracle identifier/
      );
    }
  });

  test("enforces the 128 byte identifier limit after suffixing", () => {
    expect(() =>
      suffixedTableName("CHECKPOINT_MIGRATIONS", "A".repeat(64))
    ).not.toThrow();
    // Longer than Python's 64 character suffix rule.
    expect(() => validateTableSuffix("A".repeat(65))).toThrow(
      /maximum length of 64 characters/
    );
  });

  test("keeps a reserved word usable as a suffix", () => {
    // The suffix is never a standalone identifier, so reserved words are fine.
    expect(suffixedTableName("CHECKPOINTS", "table")).toBe(
      "CHECKPOINTS_TABLE"
    );
    expect(suffixedTableName("STORE", "order")).toBe("STORE_ORDER");
  });
});

describe("Oracle identifier hardening", () => {
  test("rejects a trailing newline", () => {
    // JavaScript's `$` (without /m) does not match before a trailing newline,
    // unlike Python's re, so anchoring alone is enough here.
    expect(() => validateTableSuffix("memory\n")).toThrow();
    expect(() =>
      validateIdentifier("CHECKPOINTS\nDROP TABLE X")
    ).toThrow(/Invalid Oracle identifier/);
  });

  test("rejects characters that upper-case into ASCII", () => {
    // U+0131 -> I and U+017F -> S, so validating after folding would admit
    // them. Validation runs on the original string.
    for (const identifier of ["ıdent", "ſtore", "Åelvin"]) {
      expect(() => validateIdentifier(identifier)).toThrow(
        /Invalid Oracle identifier/
      );
    }
  });

  test("rejects control characters and whitespace", () => {
    expect(() => validateIdentifier("CHECK\tPOINTS")).toThrow(
      /Invalid Oracle identifier/
    );
    expect(() => validateTableSuffix("mem ory")).toThrow();
  });

  test("rejects non-string input with a clear message", () => {
    for (const value of [null, undefined, 123, true, {}, []]) {
      expect(() => validateIdentifier(value as never)).toThrow(
        /Invalid Oracle identifier/
      );
      expect(() => validateTableSuffix(value as never)).toThrow(
        /must start with a letter/
      );
    }
  });

  test("rejects a hostile base name even with a valid suffix", () => {
    expect(() =>
      suffixedTableName("CHECKPOINTS; DROP TABLE X", "memory")
    ).toThrow(/Invalid Oracle identifier/);
  });
});
