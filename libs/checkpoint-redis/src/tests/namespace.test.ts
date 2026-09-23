import { describe, expect, it, vi } from "vitest";
import {
  allOf,
  documentQuery,
  isWithinNamespace,
  missingFields,
  joinsUnambiguously,
  prefixTextQuery,
  prefixWildcardQuery,
  subtreeQuery,
} from "../namespace.js";
import { RedisStore } from "../store.js";

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

const NUL = String.fromCharCode(0);
const NBSP = String.fromCharCode(0xa0);

describe("documentQuery", () => {
  it("passes the namespace and key as parameters", () => {
    expect(documentQuery(["tenant", "a"], "k")).toEqual({
      query: "@prefix_exact:{$ns} @key:{$key}",
      params: { ns: "tenant.a", key: "k" },
    });
  });

  it("leaves every value as it is, except for backslashes", () => {
    const namespace = ["a) | @prefix:(victim", " padded ", "t\t"];
    expect(documentQuery(namespace, "k*").params).toEqual({
      ns: namespace.join("."),
      key: "k*",
    });
    expect(documentQuery(["a\\b", "\\"], "k\\!").params).toEqual({
      ns: "a\\\\b.\\\\",
      key: "k\\\\!",
    });
  });

  it("stops values at a NUL, as RediSearch does, and leaves out empty ones", () => {
    expect(documentQuery([`a${NUL}b`, "c"], `k${NUL}x`).params).toEqual({
      ns: "a",
      key: "k",
    });
    expect(documentQuery(["t"], "")).toEqual({
      query: "@prefix_exact:{$ns}",
      params: { ns: "t" },
    });
    expect(documentQuery([`${NUL}a`], "")).toEqual({ query: "*" });
  });
});

describe("subtreeQuery", () => {
  it("passes each label as a parameter", () => {
    expect(subtreeQuery(["tenant", "a"])).toEqual({
      query: "@prefix_labels:{$l0} @prefix_labels:{$l1}",
      params: { l0: "tenant", l1: "a" },
    });
    expect(subtreeQuery(["a\\b"]).params).toEqual({ l0: "a\\\\b" });
  });

  it("writes each label as the labels field stores it", () => {
    // Trimmed of ASCII whitespace only
    expect(subtreeQuery([" padded ", "\ta\n", `${NBSP}b`]).params).toEqual({
      l0: "padded",
      l1: "a",
      l2: `${NBSP}b`,
    });
    // Labels it stores empty or cut short are left out
    expect(subtreeQuery(["t", " ", "x".repeat(4097)]).params).toEqual({
      l0: "t",
    });
    expect(subtreeQuery(["x".repeat(4096)]).params).toEqual({
      l0: "x".repeat(4096),
    });
    // In linear time, even with a long run inside the label
    const run = "\t".repeat(1_000_000);
    expect(subtreeQuery([`${run}x${run}y`])).toEqual({ query: "*" });
    // Nothing after a NUL is stored
    expect(subtreeQuery(["t", `a${NUL}b`, "c"]).params).toEqual({
      l0: "t",
      l1: "a",
    });
    expect(subtreeQuery([])).toEqual({ query: "*" });
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

describe("missingFields", () => {
  it("reads the attribute names from FT.INFO", () => {
    const missing = (...names: string[]) =>
      missingFields({ attributes: names.map((n) => ["attribute", n]) }).map(
        (field) => field["$.prefix"].AS
      );
    expect(missing("prefix", "prefix_exact", "prefix_labels")).toEqual([]);
    expect(missing("prefix", "prefix_exact")).toEqual(["prefix_labels"]);
    expect(missing("prefix_labels")).toEqual(["prefix_exact"]);
    expect(missingFields({})).toHaveLength(2);
  });
});

describe("RedisStore on a cluster", () => {
  it("keeps the text query and never alters the index", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, documents: [] });
    const cluster = {
      masters: [],
      sendCommand: vi.fn(),
      ft: { create: vi.fn(), alter: vi.fn(), search },
    };
    const store = new RedisStore(cluster as any);
    await store.setup();
    await store.get(["tenant", "a"], "k");

    expect(cluster.ft.alter).not.toHaveBeenCalled();
    expect(cluster.sendCommand).not.toHaveBeenCalled();
    expect(search.mock.calls[0][1]).toBe("(@prefix:(tenant a)) (@key:{k})");
  });
});
