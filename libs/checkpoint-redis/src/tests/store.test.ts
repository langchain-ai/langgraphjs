import { describe, it, expect, vi } from "vitest";
import { RedisStore, type RedisConnection } from "../store.js";

function createStubClient() {
  return {
    ft: {
      search: vi.fn().mockResolvedValue({ total: 0, documents: [] }),
    },
    json: {
      get: vi.fn().mockResolvedValue(null),
    },
  };
}

const mockEmbeddings = {
  embedDocuments: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

function createVectorStore(client: ReturnType<typeof createStubClient>) {
  return new RedisStore(client as unknown as RedisConnection, {
    index: { dims: 3, embed: mockEmbeddings },
  });
}

describe("RedisStore search namespace scoping", () => {
  it("should scope vector search to every label of the prefix", async () => {
    const client = createStubClient();
    const store = createVectorStore(client);

    await store.search(["tenant", "acme"], { query: "notes" });

    expect(client.ft.search).toHaveBeenCalledTimes(1);
    const [index, query] = client.ft.search.mock.calls[0];
    expect(index).toBe("store_vectors");
    expect(query).toContain("@prefix:(tenant acme)");
  });

  it("should not widen a nested vector search to its first label", async () => {
    const client = createStubClient();
    const store = createVectorStore(client);

    await store.search(["docs", "public"], { query: "guide" });

    const [, query] = client.ft.search.mock.calls[0];
    expect(query).not.toContain("@prefix:docs*");
    expect(query).toContain("public");
  });

  it("should scope a plain search with the same clause", async () => {
    const client = createStubClient();
    const store = new RedisStore(client as unknown as RedisConnection);

    await store.search(["tenant", "acme"]);

    const [index, query] = client.ft.search.mock.calls[0];
    expect(index).toBe("store");
    expect(query).toBe("@prefix:(tenant acme)");
  });

  it("should search every namespace for an empty prefix", async () => {
    const client = createStubClient();
    const store = new RedisStore(client as unknown as RedisConnection);

    await store.search([]);

    const [, query] = client.ft.search.mock.calls[0];
    expect(query).toBe("*");
  });
});
