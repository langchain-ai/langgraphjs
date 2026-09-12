import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStore } from "../store/memory.js";
import { InvalidNamespaceError } from "../store/base.js";

describe("InMemoryStore Namespace Operations", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it("should handle basic namespace operations", async () => {
    const namespaces = [
      ["a", "b", "c"],
      ["a", "b", "d", "e"],
      ["a", "b", "d", "i"],
      ["a", "b", "f"],
      ["a", "c", "f"],
      ["b", "a", "f"],
      ["users", "123"],
      ["users", "456", "settings"],
      ["admin", "users", "789"],
    ];

    for (let i = 0; i < namespaces.length; i += 1) {
      await store.put(namespaces[i], `id_${i}`, {
        data: `value_${i.toString().padStart(2, "0")}`,
      });
    }

    let result = await store.listNamespaces({ prefix: ["a", "b"] });
    let expected = [
      ["a", "b", "c"],
      ["a", "b", "d", "e"],
      ["a", "b", "d", "i"],
      ["a", "b", "f"],
    ];
    expect(result.sort()).toEqual(expected.sort());

    result = await store.listNamespaces({ suffix: ["f"] });
    expected = [
      ["a", "b", "f"],
      ["a", "c", "f"],
      ["b", "a", "f"],
    ];
    expect(result.sort()).toEqual(expected.sort());

    result = await store.listNamespaces({ prefix: ["a"], suffix: ["f"] });
    expected = [
      ["a", "b", "f"],
      ["a", "c", "f"],
    ];
    expect(result.sort()).toEqual(expected.sort());

    result = await store.listNamespaces({ prefix: ["a", "b"], maxDepth: 3 });
    expected = [
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["a", "b", "f"],
    ];
    expect(result.sort()).toEqual(expected.sort());

    result = await store.listNamespaces({ prefix: ["a", "b"], limit: 2 });
    expected = [
      ["a", "b", "c"],
      ["a", "b", "d", "e"],
    ];
    expect(result).toEqual(expected);

    result = await store.listNamespaces({ prefix: ["a", "b"], offset: 2 });
    expected = [
      ["a", "b", "d", "i"],
      ["a", "b", "f"],
    ];
    expect(result).toEqual(expected);
  });

  it("should handle wildcards in namespace operations", async () => {
    const namespaces = [
      ["users", "123"],
      ["users", "456"],
      ["users", "789", "settings"],
      ["admin", "users", "789"],
      ["guests", "123"],
      ["guests", "456", "preferences"],
    ];

    for (let i = 0; i < namespaces.length; i += 1) {
      await store.put(namespaces[i], `id_${i}`, {
        data: `value_${i.toString().padStart(2, "0")}`,
      });
    }

    let result = await store.listNamespaces({ prefix: ["users", "*"] });
    let expected = [
      ["users", "123"],
      ["users", "456"],
      ["users", "789", "settings"],
    ];
    expect(result.sort()).toEqual(expected.sort());

    result = await store.listNamespaces({ suffix: ["*", "preferences"] });
    expected = [["guests", "456", "preferences"]];
    expect(result).toEqual(expected);

    result = await store.listNamespaces({
      prefix: ["*", "users"],
      suffix: ["*", "settings"],
    });
    expected = [];
    expect(result).toEqual(expected);

    await store.put(["admin", "users", "settings", "789"], "foo", {
      data: "some_val",
    });
    result = await store.listNamespaces({
      prefix: ["*", "users"],
      suffix: ["settings", "*"],
    });
    expected = [["admin", "users", "settings", "789"]];
    expect(result.sort()).toEqual(expected.sort());
  });

  it("should handle pagination in namespace operations", async () => {
    for (let i = 0; i < 20; i += 1) {
      const ns = ["namespace", `sub_${i.toString().padStart(2, "0")}`];
      await store.put(ns, `id_${i.toString().padStart(2, "0")}`, {
        data: `value_${i.toString().padStart(2, "0")}`,
      });
    }

    let result = await store.listNamespaces({
      prefix: ["namespace"],
      limit: 5,
      offset: 0,
    });
    let expected = Array.from({ length: 5 }, (_, i) => [
      "namespace",
      `sub_${i.toString().padStart(2, "0")}`,
    ]);
    expect(result).toEqual(expected);

    result = await store.listNamespaces({
      prefix: ["namespace"],
      limit: 5,
      offset: 5,
    });
    expected = Array.from({ length: 5 }, (_, i) => [
      "namespace",
      `sub_${(i + 5).toString().padStart(2, "0")}`,
    ]);
    expect(result).toEqual(expected);

    result = await store.listNamespaces({
      prefix: ["namespace"],
      limit: 5,
      offset: 15,
    });
    expected = Array.from({ length: 5 }, (_, i) => [
      "namespace",
      `sub_${(i + 15).toString().padStart(2, "0")}`,
    ]);
    expect(result).toEqual(expected);
  });

  it("should handle maxDepth in namespace operations", async () => {
    const namespaces = [
      ["a", "b", "c", "d"],
      ["a", "b", "c", "e"],
      ["a", "b", "f"],
      ["a", "g"],
      ["h", "i", "j", "k"],
    ];

    for (let i = 0; i < namespaces.length; i += 1) {
      await store.put(namespaces[i], `id_${i}`, {
        data: `value_${i.toString().padStart(2, "0")}`,
      });
    }

    const result = await store.listNamespaces({ maxDepth: 2 });
    const expected = [
      ["a", "b"],
      ["a", "g"],
      ["h", "i"],
    ];
    expect(result.sort()).toEqual(expected.sort());
  });

  it("should handle empty store in namespace operations", async () => {
    const result = await store.listNamespaces({});
    expect(result).toEqual([]);
  });

  it("should block colons in namespace labels", async () => {
    const doc = { foo: "bar" };
    await expect(store.put(["tenant", "acme:corp"], "k", doc)).rejects.toThrow(
      InvalidNamespaceError
    );
    await expect(store.search(["tenant:acme"])).rejects.toThrow(
      InvalidNamespaceError
    );
  });

  it("should not leak sibling namespaces that share a string prefix (issue 2721 / CVE-2026-71433)", async () => {
    await store.put(["tenant", "acme"], "note", { text: "acme's own note" });
    await store.put(["tenant", "acme-corp"], "secret", {
      text: "acme-corp CONFIDENTIAL",
    });
    await store.put(["tenant", "acmex"], "other", { text: "acmex" });
    await store.put(["tenant", "acme", "child"], "nested", { text: "child" });

    const scoped = await store.search(["tenant", "acme"], { limit: 100 });
    const namespaces = scoped.map((item) => item.namespace.join(":")).sort();
    expect(namespaces).toEqual(["tenant:acme", "tenant:acme:child"]);
    expect(scoped.find((item) => item.key === "secret")).toBeUndefined();
    expect(await store.get(["tenant", "acme"], "secret")).toBeNull();

    const empty = await store.search([], { limit: 100 });
    expect(empty).toHaveLength(4);

    const fo = await store.search(["fo"], { limit: 100 });
    expect(fo).toHaveLength(0);
  });

  it("search prefix match is segment-wise, including empty prefix", async () => {
    const fixtures: string[][] = [
      ["foo"],
      ["foo", "child"],
      ["foo", "child", "deep"],
      ["foobar"],
      ["foobar", "baz"],
      ["foo2"],
    ];
    for (const ns of fixtures) {
      await store.put(ns, "k", { v: 1 });
    }

    const isSegmentPrefix = (query: string[], ns: string[]): boolean => {
      if (query.length === 0) return true;
      if (query.length > ns.length) return false;
      return query.every((part, i) => part === ns[i]);
    };

    const queries: string[][] = [
      [],
      ["foo"],
      ["foo", "child"],
      ["foobar"],
      ["foo2"],
      ["fo"],
      ["foo", "nope"],
    ];

    for (const query of queries) {
      const got = new Set(
        (await store.search(query, { limit: 100 })).map((item) =>
          item.namespace.join("\0")
        )
      );
      const expected = new Set(
        fixtures
          .filter((ns) => isSegmentPrefix(query, ns))
          .map((ns) => ns.join("\0"))
      );
      expect(got, `query ${JSON.stringify(query)}`).toEqual(expected);
    }
  });

  it("should block invalid namespaces", async () => {
    const doc = { foo: "bar" };

    await expect(store.put([], "foo", doc)).rejects.toThrow(
      InvalidNamespaceError
    );
    await expect(store.put(["the", "thing.about"], "foo", doc)).rejects.toThrow(
      InvalidNamespaceError
    );
    await expect(store.put(["some", "fun", ""], "foo", doc)).rejects.toThrow(
      InvalidNamespaceError
    );
    await expect(store.put(["langgraph", "foo"], "bar", doc)).rejects.toThrow(
      InvalidNamespaceError
    );

    await store.put(["foo", "langgraph", "foo"], "bar", doc);
    const result = await store.get(["foo", "langgraph", "foo"], "bar");
    expect(result?.value).toEqual(doc);

    const searchResult = await store.search(["foo", "langgraph", "foo"]);
    expect(searchResult[0].value).toEqual(doc);

    await store.delete(["foo", "langgraph", "foo"], "bar");
    const deletedResult = await store.get(["foo", "langgraph", "foo"], "bar");
    expect(deletedResult).toBeNull();

    await store.batch([
      { namespace: ["valid", "namespace"], key: "key", value: doc },
    ]);
    const batchResult = await store.get(["valid", "namespace"], "key");
    expect(batchResult?.value).toEqual(doc);

    const batchSearchResult = await store.search(["valid", "namespace"]);
    expect(batchSearchResult[0].value).toEqual(doc);

    await store.delete(["valid", "namespace"], "key");
    const batchDeletedResult = await store.get(["valid", "namespace"], "key");
    expect(batchDeletedResult).toBeNull();
  });
});
