import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorReply } from "redis";
import { RedisStore } from "../store.js";
import { createRedisContainer } from "./redis-container.js";

type Client = Awaited<ReturnType<typeof createRedisContainer>>["client"];

// Each text is a number; the larger it is, the farther from the query.
const index = {
  dims: 2,
  embed: {
    embedDocuments: async (texts: string[]) =>
      texts.map((text) => [1, Number(text) / 1000 || 0]),
    embedQuery: async () => [1, 0],
  },
};

/** What `run` returns, and the queries it sends to FT.SEARCH. */
async function withQueries<T>(client: Client, run: () => Promise<T>) {
  const search = vi.spyOn(client.ft, "search");
  try {
    const result = await run();
    const queries = search.mock.calls.map(([, query]) => String(query));
    return { result, queries };
  } finally {
    search.mockRestore();
  }
}

/** The documents, or vectors, stored under exactly `prefix` and `key`. */
async function stored(
  client: Client,
  prefix: string,
  key: string,
  kind = "store"
) {
  const docs: any[] = [];
  for (const id of await client.keys(`${kind}:*`)) {
    const doc = (await client.json.get(id)) as any;
    if (doc?.prefix === prefix && doc.key === key) docs.push({ ...doc, id });
  }
  return docs;
}

/** Deterministic random numbers below `n` (mulberry32). */
function random(seed: number) {
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n) | 0;
  };
}

describe("namespace isolation", () => {
  let container: Awaited<ReturnType<typeof createRedisContainer>>;
  let store: RedisStore;

  beforeAll(async () => {
    container = await createRedisContainer();
    store = new RedisStore(container.client, { index });
    await store.setup();
  }, 120_000);

  afterAll(async () => {
    await container?.cleanup();
  });

  it("reads and searches only the namespace asked for", async () => {
    const namespaces = [
      ["tenant", "a"],
      ["tenant", "a", "notes"],
      ["tenant", "ab"],
      ["a", "tenant"],
      ["tenant", "A"],
      ["tenant", "a-b"],
      ["tenant", "a) | @prefix:(victim"],
      ["tenant", "x".repeat(5000)],
    ];
    for (const [i, namespace] of namespaces.entries()) {
      await store.put(namespace, `key${i}`, { text: String(i) });
    }
    for (const [i, namespace] of namespaces.entries()) {
      expect((await store.get(namespace, `key${i}`))?.namespace).toEqual(
        namespace
      );
      expect(
        await store.get(namespace, `key${(i + 1) % namespaces.length}`)
      ).toBeNull();
      for (const query of [undefined, "near"]) {
        const found = await store.search(namespace, { limit: 50, query });
        const expected = namespaces.filter((other) =>
          namespace.every((label, j) => other[j] === label)
        );
        expect(expected).toEqual(
          expect.arrayContaining(found.map((item) => item.namespace))
        );
      }
    }
  });

  it("replaces and deletes only the exact namespace and its vector", async () => {
    const { client } = container;
    const others = [
      ["one", "scope"],
      ["scope", "one", "child"],
      ["scope", "One"],
    ];
    for (const namespace of [["scope", "one"], ...others]) {
      await store.put(namespace, "same", { text: "1", namespace });
    }
    await store.put(["scope", "one"], "same", { text: "2" });
    await store.delete(["scope", "one"], "same");

    expect(await stored(client, "scope.one", "same")).toEqual([]);
    expect(await stored(client, "scope.one", "same", "store_vectors")).toEqual(
      []
    );
    for (const namespace of others) {
      const flat = namespace.join(".");
      expect((await store.get(namespace, "same"))?.value).toEqual({
        text: "1",
        namespace,
      });
      expect(await stored(client, flat, "same", "store_vectors")).toHaveLength(
        1
      );
    }
  });

  it("refreshes the TTL of the namespace's own documents only", async () => {
    const { client } = container;
    const ttl = new RedisStore(client, { index, ttl: { defaultTTL: 10 } });
    const namespaces = [
      ["ttl", "a"],
      ["a", "ttl"],
      ["ttl", "A"],
      ["ttl", "ab"],
    ];
    for (const namespace of namespaces) {
      await ttl.put(namespace, "k", { text: "1" });
    }
    const [mine] = await stored(client, "ttl.a", "k");
    const others: string[] = [];
    for (const namespace of namespaces.slice(1)) {
      for (const kind of ["store", "store_vectors"]) {
        const docs = await stored(client, namespace.join("."), "k", kind);
        others.push(...docs.map((doc) => doc.id));
      }
    }
    for (const id of [mine.id, ...others]) await client.expire(id, 30);

    await ttl.get(["ttl", "a"], "k", { refreshTTL: true });
    await ttl.search(["ttl", "a"], { refreshTTL: true });
    await ttl.search(["ttl", "a"], { refreshTTL: true, query: "near" });

    expect(await client.ttl(mine.id)).toBeGreaterThan(30);
    for (const id of others) {
      expect(await client.ttl(id)).toBeLessThanOrEqual(30);
    }
  });

  it("matches keys as earlier versions did", async () => {
    // Ignoring case
    await store.put(["case"], "k", { v: "lower" });
    await store.put(["case"], "K", { v: "upper" });
    expect((await store.get(["case"], "k"))?.value).toEqual({ v: "upper" });
    expect(await stored(container.client, "case", "k")).toEqual([]);
    // The empty key, within its namespace
    await store.put(["empty", "child"], "", { v: 0 });
    await store.put(["empty"], "", { v: 1 });
    expect((await store.get(["empty"], ""))?.value).toEqual({ v: 1 });
    expect((await store.get(["empty", "child"], ""))?.value).toEqual({ v: 0 });
  });

  it("pages through the namespace's documents, skipping others'", async () => {
    // Documents from another namespace that shares the words take up places
    // on each page, so pages can come back short, as earlier versions' pages
    // held those documents instead. Every own document still appears once.
    for (let i = 0; i < 25; i++) {
      const namespace = i % 5 === 0 ? ["pg", "a"] : ["x", "pg", "a", `y${i}`];
      await store.put(namespace, `k${i}`, { i });
    }
    const keys: string[] = [];
    for (let offset = 0; offset < 30; offset += 5) {
      for (const item of await store.search(["pg", "a"], {
        offset,
        limit: 5,
      })) {
        expect(item.namespace).toEqual(["pg", "a"]);
        keys.push(item.key);
      }
    }
    expect(keys.sort()).toEqual(["k0", "k10", "k15", "k20", "k5"]);
  });

  it("reads nothing through an empty or dotted label", async () => {
    await store.put(["dot", "x"], "k", { v: 1 });
    expect(await store.get(["dot.x"], "k")).toBeNull();
    expect(await store.search(["dot.x"])).toEqual([]);
    // [""] joins to the same prefix as [], which searches everything
    expect(await store.search([""])).toEqual([]);
    expect(await store.search([], { limit: 1 })).toHaveLength(1);
  });

  it("keeps random hostile namespaces apart", async () => {
    const rnd = random(12);
    const pool = [
      ..."abzAZ09_",
      ...["a", "is", "the", " ", "\t", "\n", "\\", "|", "{", "}", "(", ")"],
      ...['"', "'", "*", "~", "-", ":", "@", "%", "$", "`", "é", "日"],
      ...[String.fromCharCode(0), "x".repeat(5000)],
    ];
    const label = () =>
      Array.from({ length: 1 + rnd(4) }, () => pool[rnd(pool.length)]).join("");
    const flats = new Set<string>();
    const made: string[][] = [];
    while (made.length < 120) {
      const namespace = ["fz", ...Array.from({ length: 1 + rnd(2) }, label)];
      const flat = namespace.join(".");
      if (
        namespace.some((l) => l === "" || l.includes(".")) ||
        flats.has(flat)
      ) {
        continue;
      }
      flats.add(flat);
      made.push(namespace);
      await store.put(namespace, "k", { flat, text: String(rnd(900)) });
    }

    for (const namespace of made) {
      const flat = namespace.join(".");
      const expected = [...flats].filter(
        (other) => other === flat || other.startsWith(`${flat}.`)
      );
      // The text query rejects some of these labels as a syntax error, and
      // misses documents under others, as it always did. What must hold is
      // that nothing from another namespace comes back.
      const rejected = (error: unknown) => {
        expect(error).toBeInstanceOf(ErrorReply);
        return undefined;
      };
      for (const query of [undefined, "near"]) {
        const got = (
          (await store
            .search(namespace, { limit: 1000, query })
            .catch(rejected)) ?? []
        ).map((item) => item.namespace.join("."));
        expect(expected).toEqual(expect.arrayContaining(got));
      }
      const item = await store.get(namespace, "k").catch(rejected);
      expect([undefined, null, flat]).toContain(item?.value.flat ?? item);
    }
  });

  it("finds a namespace's vectors behind other namespaces' nearer ones", async () => {
    // Every user's namespace starts with the same word, so narrowing by that
    // word alone leaves only other users' vectors among the nearest.
    for (let user = 0; user < 30; user++) {
      for (let i = 0; i < 3; i++) {
        const text = String(user === 3 ? 900 + i : user * 3 + i);
        await store.put(["memories", `user-${user}`], `m${i}`, { text });
      }
    }
    const found = await store.search(["memories", "user-3"], {
      query: "near",
      limit: 3,
    });
    expect(found.map((item) => item.key).sort()).toEqual(["m0", "m1", "m2"]);
    expect(found.every((item) => item.namespace[1] === "user-3")).toBe(true);
  });

  it("searches every namespace's vectors through the empty namespace", async () => {
    for (const namespace of [["all", "a"], ["all", "b"], ["every"]]) {
      await store.put(namespace, "k", { text: "1" });
    }
    const { result, queries } = await withQueries(container.client, () =>
      store.search([], { query: "near", limit: 3 })
    );
    // The query earlier versions sent, with nothing filtered out
    expect(queries).toEqual(["(*)=>[KNN 3 @embedding $BLOB]"]);
    expect(result).toHaveLength(3);
  });

  it.each([
    // Redis rejects the all-words query for this label
    ["a)", "(@prefix:(memories a)))"],
    // Redis accepts it, but it matches no document
    ["CORP\\alice", "(@prefix:(memories CORP\\alice))"],
  ])("falls back to the first-word query for %s", async (label, narrow) => {
    await store.put(["memories", label], "mine", { text: "1" });
    const { result, queries } = await withQueries(container.client, () =>
      store.search(["memories", label], { query: "near", limit: 100 })
    );
    expect(queries).toEqual([
      `${narrow}=>[KNN 100 @embedding $BLOB]`,
      "(@prefix:memories*)=>[KNN 100 @embedding $BLOB]",
    ]);
    expect(result.map((item) => item.key)).toEqual(["mine"]);
  });

  it("throws if Redis cannot answer vector search", async () => {
    const search = vi
      .spyOn(container.client.ft, "search")
      .mockRejectedValue(new Error("Socket closed unexpectedly"));
    try {
      await expect(
        store.search(["memories", "user-3"], { query: "near" })
      ).rejects.toThrow("Socket closed unexpectedly");
    } finally {
      search.mockRestore();
    }
  });

  it("doesn't fetch other namespaces' documents for vector search", async () => {
    await store.put(["fetch", "other"], "k", { text: "1" });
    const get = vi.spyOn(container.client.json, "get");
    try {
      const found = await store.search(["fetch", "none"], { query: "near" });
      expect(found).toEqual([]);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it("trusts the stored document's namespace over its vector's", async () => {
    // A vector whose namespace disagrees with its stored document's, as
    // another client could write.
    const { client } = container;
    const doc = { key: "k", created_at: 1, updated_at: 1 };
    await client.json.set("store:mismatch", "$", {
      ...doc,
      prefix: "vm.other",
      value: { text: "1" },
    });
    await client.json.set("store_vectors:mismatch", "$", {
      ...doc,
      prefix: "vm.mine",
      field_name: "text",
      embedding: [1, 0],
    });
    const found = await store.search(["vm", "mine"], { query: "near" });
    expect(found).toEqual([]);
  });

  it("still finds the document if look-alikes go between the searches", async () => {
    const { client } = container;
    // Ties come back oldest first on Redis 7.4 and newest first on Redis 8,
    // so with one look-alike written before and two after, ours is not first.
    const others = [
      ["mv", "A"],
      ["a", "mv"],
      ["A", "mv"],
    ];
    await store.put(others[0], "k", {});
    await store.put(["mv", "a"], "k", { v: "mine" });
    for (const namespace of others.slice(1))
      await store.put(namespace, "k", {});
    const search = client.ft.search.bind(client.ft);
    const spy = vi
      .spyOn(client.ft, "search")
      .mockImplementationOnce(async (...args: any[]) => {
        const first = await (search as any)(...args);
        for (const namespace of others) {
          for (const doc of await stored(client, namespace.join("."), "k")) {
            await client.del(doc.id);
          }
        }
        return first;
      });
    try {
      await store.put(["mv", "a"], "k", { v: "again" });
    } finally {
      spy.mockRestore();
    }
    const docs = await stored(client, "mv.a", "k");
    expect(docs.map((doc) => doc.value)).toEqual([{ v: "again" }]);
  });
});

describe("a namespace with many look-alike documents", () => {
  let container: Awaited<ReturnType<typeof createRedisContainer>>;
  let store: RedisStore;

  /** Write documents as any client would, in batches. */
  async function write(docs: [string, string, string][]) {
    for (let from = 0; from < docs.length; from += 5000) {
      const batch = container.client.multi();
      for (const [id, prefix, key] of docs.slice(from, from + 5000)) {
        batch.json.set(id, "$", {
          prefix,
          key,
          value: { prefix },
          created_at: 1,
          updated_at: 1,
        });
      }
      await batch.exec();
    }
  }

  beforeAll(async () => {
    container = await createRedisContainer();
    store = new RedisStore(container.client);
    await store.setup();
    // 10,050 child namespaces share the key of their parent, written last.
    const children: [string, string, string][] = Array.from(
      { length: 10_050 },
      (_, i) => [`store:child${i}`, `users.u${i}`, "profile"]
    );
    await write([...children, ["store:parent", "users", "profile"]]);
    // 500 namespaces whose labels hold no indexed words besides the
    // victim's, with the victim written in the middle of them.
    const punctuation = "!#$%&*+,/;<=>?^`~";
    const label = (i: number) =>
      Array.from(String(i), (d) => punctuation[Number(d)]).join("") +
      punctuation[10 + (i % 7)];
    const flood: [string, string, string][] = Array.from(
      { length: 500 },
      (_, i) => [`store:flood${i}`, `${label(i)}.victim`, "k"]
    );
    flood.splice(250, 0, ["store:victim", "victim", "k"]);
    await write(flood);
  }, 180_000);

  afterAll(async () => {
    await container?.cleanup();
  });

  it("finds a parent namespace's document behind its children's", async () => {
    expect((await store.get(["users"], "profile"))?.value).toEqual({
      prefix: "users",
    });
    await store.put(["users"], "profile", { v: "new" });
    expect(await container.client.exists("store:parent")).toBe(0);
    expect((await store.get(["users"], "profile"))?.value).toEqual({
      v: "new",
    });
  });

  it("never uses another namespace's document behind many look-alikes", async () => {
    // More look-alikes than a lookup checks: it may miss the namespace's own
    // document, but never reads, replaces or deletes theirs.
    const { client } = container;
    const flood = Array.from({ length: 500 }, (_, i) => `store:flood${i}`);
    expect([undefined, "victim"]).toContain(
      (await store.get(["victim"], "k"))?.value.prefix
    );
    await store.put(["victim"], "k", { prefix: "victim" });
    await store.delete(["victim"], "k");
    expect(await client.exists(flood)).toBe(flood.length);
  });
});

describe("an existing store", () => {
  let container: Awaited<ReturnType<typeof createRedisContainer>>;

  beforeAll(async () => {
    container = await createRedisContainer();
    // The index and documents exactly as earlier versions write them.
    await container.client.ft.create(
      "store",
      {
        "$.prefix": { type: "TEXT", AS: "prefix" },
        "$.key": { type: "TAG", AS: "key" },
        "$.created_at": { type: "NUMERIC", AS: "created_at" },
        "$.updated_at": { type: "NUMERIC", AS: "updated_at" },
      } as any,
      { ON: "JSON", PREFIX: "store:" }
    );
    for (let i = 0; i < 20; i++) {
      await container.client.json.set(`store:old${i}`, "$", {
        prefix: `old.n${i}`,
        key: `k${i}`,
        value: { v: i },
        created_at: 1,
        updated_at: 1,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await container?.cleanup();
  });

  it("keeps its index and documents as they are", async () => {
    const { client } = container;
    const fields = async () => {
      const info = (await client.sendCommand(["FT.INFO", "store"])) as any[];
      return JSON.stringify(info[info.indexOf("attributes") + 1]);
    };
    const schema = await fields();
    const before = await client.json.get("store:old7");
    const store = new RedisStore(client);
    await store.setup();
    expect(await fields()).toBe(schema);

    expect((await store.get(["old", "n7"], "k7"))?.value).toEqual({ v: 7 });
    expect(await client.json.get("store:old7")).toEqual(before);

    // Replacing a document an earlier version wrote leaves one copy.
    await store.put(["old", "n8"], "k8", { v: "new" });
    const copies = await stored(client, "old.n8", "k8");
    expect(copies.map((doc) => doc.value)).toEqual([{ v: "new" }]);
  });
});
