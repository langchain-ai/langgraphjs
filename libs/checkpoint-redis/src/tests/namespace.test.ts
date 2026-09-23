import { describe, expect, it, vi } from "vitest";
import {
  allOf,
  hasNamespaceLabels,
  isWithinNamespace,
  joinsUnambiguously,
  namespaceLabelsQuery,
  prefixTextQuery,
  prefixWildcardQuery,
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
  it("rejects a label that contains the separator", () => {
    expect(joinsUnambiguously(["a.b"])).toBe(false);
    expect(joinsUnambiguously(["a", "b"])).toBe(true);
    expect(joinsUnambiguously([])).toBe(true);
    expect(joinsUnambiguously([1, 2] as unknown as string[])).toBe(false);
  });
});

describe("namespaceLabelsQuery", () => {
  it("matches each label as an exact tag", () => {
    expect(namespaceLabelsQuery(["tenant", "a"])).toBe(
      "@prefix_labels:{tenant} @prefix_labels:{a}"
    );
  });

  it("escapes every ASCII character that is not a letter or digit", () => {
    expect(namespaceLabelsQuery(["a) | @prefix:(victim"])).toBe(
      "@prefix_labels:{a\\)\\ \\|\\ \\@prefix\\:\\(victim}"
    );
    expect(namespaceLabelsQuery(["x_y-z", "é日"])).toBe(
      "@prefix_labels:{x\\_y\\-z} @prefix_labels:{é日}"
    );
  });

  it("leaves out labels a tag cannot match exactly", () => {
    const unmatchable = [" a", "a ", "a\tb", "a\x7fb", "x".repeat(4097), ""];
    for (const label of unmatchable) {
      expect(namespaceLabelsQuery(["t", label])).toBe("@prefix_labels:{t}");
    }
    expect(namespaceLabelsQuery([" "])).toBe("*");
    expect(namespaceLabelsQuery([])).toBe("*");
    expect(namespaceLabelsQuery(["x".repeat(4096)])).toBe(
      `@prefix_labels:{${"x".repeat(4096)}}`
    );
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
    expect(allOf("*", "@key:{k}")).toBe("(@key:{k})");
    expect(allOf("*", "*")).toBe("*");
  });
});

describe("hasNamespaceLabels", () => {
  it("reads the attribute names from FT.INFO", () => {
    const prefix = ["identifier", "$.prefix", "attribute", "prefix"];
    const labels = ["identifier", "$.prefix", "attribute", "prefix_labels"];
    expect(hasNamespaceLabels({ attributes: [prefix, labels] })).toBe(true);
    expect(hasNamespaceLabels({ attributes: [prefix] })).toBe(false);
    expect(hasNamespaceLabels({})).toBe(false);
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
