import { describe, it, expect, vi } from "vitest";
import { createClient } from "redis";
import { isWithinNamespace, RedisStore } from "../store.js";

function createStubClient() {
  const client = createClient();
  vi.spyOn(client.ft, "search").mockResolvedValue({ total: 0, documents: [] });
  vi.spyOn(client.ft, "create").mockRejectedValue(
    new Error("Index already exists")
  );
  vi.spyOn(client.ft, "alter").mockResolvedValue("OK");
  return client;
}

const mockEmbeddings = {
  embedDocuments: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

function createVectorStore(client: ReturnType<typeof createStubClient>) {
  return new RedisStore(client, {
    index: { dims: 3, embed: mockEmbeddings },
  });
}

/** A stored document, as RediSearch returns it. */
function doc(prefix: string, key: string, id = `store:${prefix}:${key}`) {
  return {
    id,
    value: { prefix, key, value: {}, created_at: 1, updated_at: 1 },
  };
}

describe("namespace boundaries", () => {
  // Every isolation guarantee in this package reduces to this predicate: the
  // indexed query only decides which documents it runs over, and an
  // over-broad candidate set is harmless as long as these cases hold.
  it.each<[found: string, prefix: string, within: boolean]>([
    ["tenant.a", "tenant.a", true],
    ["tenant.a.notes", "tenant.a", true],
    ["tenant.a.notes.2026", "tenant.a", true],
    // A shared string prefix is not a shared namespace. This is the bug.
    ["tenant.ab", "tenant.a", false],
    ["tenant.a2", "tenant.a", false],
    // The same labels in a different order, which a TEXT index cannot tell
    // apart because it stores an unordered bag of terms.
    ["a.tenant", "tenant.a", false],
    ["notes-tenant.alice", "tenant-alice.notes", false],
    // A separator that is not "." must never act as a segment boundary.
    ["tenant-a", "tenant.a", false],
    ["tenant.a-b", "tenant.a", false],
    // Matching stays case-sensitive even though the index case-folds.
    ["Tenant.A", "tenant.a", false],
    // A parent is not contained by its own child.
    ["tenant", "tenant.a", false],
    // The empty prefix is the whole store.
    ["tenant.a", "", true],
    ["", "", true],
  ])("%s within %s is %s", (found, prefix, within) => {
    expect(isWithinNamespace(found, prefix)).toBe(within);
  });
});

describe("namespace candidate queries", () => {
  it.each([false, true])(
    "narrows candidates with the indexed prefix tokens with vector=%s",
    async (vector) => {
      const client = createStubClient();
      const store = vector ? createVectorStore(client) : new RedisStore(client);
      await store.search(["tenant", "acme-notes"], {
        offset: 2,
        limit: 3,
        query: vector ? "notes" : undefined,
      });
      const [index, query] = vi.mocked(client.ft.search).mock.calls[0];
      expect(index).toBe(vector ? "store_vectors" : "store");
      expect(query).toBe(
        vector
          ? "(@prefix:(tenant acme notes))=>[KNN 100 @embedding $BLOB]"
          : "@prefix:(tenant acme notes)"
      );
    }
  );

  it("searches every namespace for an empty prefix", async () => {
    const client = createStubClient();
    await new RedisStore(client).search([]);
    expect(vi.mocked(client.ft.search).mock.calls[0][1]).toBe("*");
  });

  it("scopes lookups by prefix tokens and the exact key", async () => {
    const client = createStubClient();
    await new RedisStore(client).get(["tenant", "acme"], "k");
    expect(client.ft.search).toHaveBeenCalledWith(
      "store",
      "(@prefix:(tenant acme)) (@key:{k})",
      { LIMIT: { from: 0, size: 100 } }
    );
  });

  it("drops terms Redis would not have indexed", async () => {
    const client = createStubClient();
    const store = new RedisStore(client);
    const queryFor = async (label: string) => {
      vi.mocked(client.ft.search).mockClear();
      await store.search(["tenant", label]);
      return vi.mocked(client.ft.search).mock.calls[0][1];
    };

    // Punctuation separates, so the word runs around it are real terms.
    expect(await queryFor("a|b")).toBe("@prefix:(tenant b)");
    expect(await queryFor("a,b")).toBe("@prefix:(tenant b)");
    // "a" alone is a stopword, which RediSearch never indexes.
    expect(await queryFor("a")).toBe("@prefix:(tenant)");
    // Non-ASCII is term content, not a separator, so such labels narrow too.
    expect(await queryFor("café")).toBe("@prefix:(tenant café)");
    expect(await queryFor("日本語")).toBe("@prefix:(tenant 日本語)");
    expect(await queryFor("naïve-notes")).toBe("@prefix:(tenant naïve notes)");
    // A backslash or control character fuses the runs on either side into one
    // term, so nothing read off those labels was indexed -- skip them whole.
    expect(await queryFor("a\\b")).toBe("@prefix:(tenant)");
    expect(await queryFor("a/b\né")).toBe("@prefix:(tenant)");
    // Punctuation is query syntax, so a label cannot rewrite the query.
    expect(await queryFor("a) | @prefix:(victim")).toBe(
      "@prefix:(tenant prefix victim)"
    );
  });

  it("matches every namespace when no usable term survives", async () => {
    const client = createStubClient();
    await new RedisStore(client).search(["*"]);
    expect(vi.mocked(client.ft.search).mock.calls[0][1]).toBe("*");
  });
});

describe("namespace isolation", () => {
  it("rejects a document from a namespace that only shares prefix tokens", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search).mockResolvedValue({
      total: 1,
      documents: [doc("tenant.A", "k")],
    });
    expect(await new RedisStore(client).get(["tenant", "a"], "k")).toBeNull();
  });

  it("returns the exact document rather than the first candidate", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search).mockResolvedValue({
      total: 2,
      documents: [doc("a.tenant", "k"), doc("tenant.a", "k")],
    });
    const result = await new RedisStore(client).get(["tenant", "a"], "k");
    expect(result?.namespace).toEqual(["tenant", "a"]);
  });

  it("pages past colliding candidates to reach the exact document", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search)
      .mockResolvedValueOnce({ total: 150, documents: [doc("tenant.b", "k")] })
      .mockResolvedValueOnce({ total: 150, documents: [doc("tenant.a", "k")] });
    const result = await new RedisStore(client).get(["tenant", "a"], "k");
    expect(result?.namespace).toEqual(["tenant", "a"]);
    expect(vi.mocked(client.ft.search).mock.calls[1][2]).toMatchObject({
      LIMIT: { from: 100, size: 100 },
    });
  });

  it("does not overwrite a document from a colliding namespace", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search).mockResolvedValue({
      total: 1,
      documents: [doc("tenant.A", "k", "store:sibling")],
    });
    const del = vi.spyOn(client, "del").mockResolvedValue(1);
    vi.spyOn(client.json, "set").mockResolvedValue("OK");
    await new RedisStore(client).put(["tenant", "a"], "k", {});
    expect(del).not.toHaveBeenCalledWith("store:sibling");
  });

  it("drops search results that only share prefix tokens", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search).mockResolvedValue({
      total: 4,
      documents: [
        doc("tenant.acme", "a"),
        doc("tenant.acme.notes", "b"),
        doc("tenant.acme2", "c"),
        doc("acme.tenant", "d"),
      ],
    });
    const items = await new RedisStore(client).search(["tenant", "acme"]);
    expect(items.map((item) => item.namespace.join("."))).toEqual([
      "tenant.acme",
      "tenant.acme.notes",
    ]);
  });

  it("pages further when rejected candidates leave the page short", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search)
      .mockResolvedValueOnce({
        total: 150,
        documents: [doc("other.tenant", "x"), doc("tenant", "a")],
      })
      .mockResolvedValueOnce({
        total: 150,
        documents: [doc("tenant", "b")],
      });
    const items = await new RedisStore(client).search(["tenant"], { limit: 2 });
    expect(items.map((item) => item.key)).toEqual(["a", "b"]);
    expect(client.ft.search).toHaveBeenCalledTimes(2);
  });
});

describe("vector search isolation", () => {
  const vectorDocs = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => ({
      id: `store_vectors:${prefix}-${i}`,
      value: { prefix, key: `k${i}`, __embedding_score: "0.1" },
    }));

  it("widens the KNN search when candidates are rejected", async () => {
    const client = createStubClient();
    vi.spyOn(client.json, "get").mockResolvedValue(
      doc("tenant", "k0").value as any
    );
    vi.mocked(client.ft.search)
      .mockResolvedValueOnce({ total: 100, documents: vectorDocs(100, "tenant2") })
      .mockResolvedValueOnce({
        total: 200,
        documents: [...vectorDocs(198, "tenant2"), ...vectorDocs(2, "tenant")],
      });
    await createVectorStore(client).search(["tenant"], {
      query: "notes",
      limit: 2,
    });
    expect(client.ft.search).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.ft.search).mock.calls[0][1]).toContain("KNN 100");
    expect(vi.mocked(client.ft.search).mock.calls[1][1]).toContain("KNN 200");
  });

  it("stops widening once the vector index is exhausted", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search).mockResolvedValue({
      total: 3,
      documents: vectorDocs(3, "tenant2"),
    });
    const items = await createVectorStore(client).search(["tenant"], {
      query: "notes",
    });
    expect(items).toEqual([]);
    expect(client.ft.search).toHaveBeenCalledTimes(1);
  });
});

describe("setup and error handling", () => {
  it("never alters the index schema", async () => {
    const client = createStubClient();
    await new RedisStore(client).setup();
    expect(client.ft.alter).not.toHaveBeenCalled();
  });

  it("allows denied creation only when the existing index is usable", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.create).mockRejectedValue(new Error("NOPERM"));
    await new RedisStore(client).setup();
    vi.mocked(client.ft.search).mockRejectedValue(new Error("No such index"));
    // The creation failure is what a reader needs, so it survives as `cause`.
    await expect(new RedisStore(client).setup()).rejects.toMatchObject({
      message: expect.stringContaining('Failed to create RedisStore index'),
      cause: expect.objectContaining({ message: "NOPERM" }),
    });
  });

  it.each(["get", "put", "delete"])(
    "propagates actual query failures for %s",
    async (operation) => {
      const client = createStubClient();
      vi.mocked(client.ft.search).mockRejectedValue(
        new Error("NOPERM search denied")
      );
      const store = new RedisStore(client);
      const result =
        operation === "get"
          ? store.get(["tenant"], "k")
          : operation === "put"
            ? store.put(["tenant"], "k", {})
            : store.delete(["tenant"], "k");
      await expect(result).rejects.toThrow("NOPERM search denied");
    }
  );

  it("reports a missing index as a setup failure", async () => {
    const client = createStubClient();
    vi.mocked(client.ft.search).mockRejectedValue(new Error("no such index"));
    await expect(new RedisStore(client).get(["tenant"], "k")).rejects.toThrow(
      /store\.setup\(\)/
    );
  });
});

it.each(["tenant.a", ".", "a.", ".a", ""])(
  "rejects invalid search label %j before querying Redis",
  async (label) => {
    const client = createStubClient();
    const store = createVectorStore(client);

    for (const query of [undefined, "notes"]) {
      await expect(store.search([label], { query })).rejects.toThrow();
      await expect(
        store.batch([{ namespacePrefix: [label], query }])
      ).rejects.toThrow();
    }

    expect(client.ft.search).not.toHaveBeenCalled();
  }
);
