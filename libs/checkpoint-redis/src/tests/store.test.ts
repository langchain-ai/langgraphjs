import { describe, it, expect, vi } from "vitest";
import { createClient } from "redis";
import { RedisStore } from "../store.js";

function createStubClient() {
  const client = createClient();
  vi.spyOn(client.ft, "search").mockResolvedValue({ total: 0, documents: [] });

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

describe("RedisStore search namespace scoping", () => {
  it.each([false, true])(
    "fills the scoped page past sibling candidates with vector=%s",
    async (vector) => {
      const client = createStubClient();
      const store = vector ? createVectorStore(client) : new RedisStore(client);
      const value = {
        prefix: "tenant.acme",
        key: "own",
        value: { text: "own" },
        created_at: 1,
        updated_at: 1,
      };
      const siblings = Array.from({ length: 100 }, (_, i) => ({
        id: `store:sibling${i}`,
        value: { ...value, prefix: "tenant.acme2" },
      }));
      const own = { id: "store:own", value };
      vi.mocked(client.ft.search)
        .mockResolvedValueOnce({ total: 101, documents: siblings })
        .mockResolvedValueOnce({
          total: 101,
          documents: vector ? [...siblings, own] : [own],
        });
      vi.spyOn(client.json, "get").mockResolvedValue(value);
      const results = await store.search(["tenant", "acme"], {
        limit: 1,
        query: vector ? "notes" : undefined,
      });
      expect(results.map((item) => item.key)).toEqual(["own"]);
      expect(client.ft.search).toHaveBeenCalledTimes(2);
    }
  );

  it.each([false, true])(
    "stops when only sibling candidates remain with vector=%s",
    async (vector) => {
      const client = createStubClient();
      vi.mocked(client.ft.search).mockResolvedValue({
        total: 1,
        documents: [{ id: "store:sibling", value: { prefix: "tenant.ab" } }],
      });
      const store = vector ? createVectorStore(client) : new RedisStore(client);
      expect(
        await store.search(["tenant", "a"], {
          query: vector ? "notes" : undefined,
        })
      ).toEqual([]);
      expect(client.ft.search).toHaveBeenCalledTimes(1);
    }
  );

  it("searches every namespace for an empty prefix", async () => {
    const client = createStubClient();
    await new RedisStore(client).search([]);
    expect(vi.mocked(client.ft.search).mock.calls[0][1]).toBe("*");
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

it("keeps setup limited to the existing index creation", async () => {
  const client = createStubClient();
  vi.spyOn(client.ft, "create").mockRejectedValue(
    new Error("Index already exists")
  );
  const alter = vi.spyOn(client.ft, "alter");
  const info = vi.spyOn(client, "sendCommand");
  const write = vi.spyOn(client.json, "set");
  const evalCommand = vi.spyOn(client, "eval");
  await new RedisStore(client).setup();
  expect(alter).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(evalCommand).not.toHaveBeenCalled();
});
