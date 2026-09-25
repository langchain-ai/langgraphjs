import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

/** The queries `run` sends to FT.SEARCH. */
async function queriesOf(client: Client, run: () => Promise<unknown>) {
  const search = vi.spyOn(client.ft, "search");
  try {
    await run();
    return search.mock.calls.map(([, query]) => String(query));
  } finally {
    search.mockRestore();
  }
}

/** Every stored document under exactly `prefix` and `key`. */
async function stored(client: Client, prefix: string, key: string) {
  const ids = await client.keys("store:*");
  const docs = await Promise.all(ids.map((id) => client.json.get(id)));
  return docs.filter(
    (doc: any) => doc.prefix === prefix && doc.key === key
  ) as any[];
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

  it("replaces and deletes only the exact namespace", async () => {
    const collide = [
      ["scope", "one"],
      ["one", "scope"],
      ["scope", "one", "child"],
      ["scope", "One"],
    ];
    for (const namespace of collide) {
      await store.put(namespace, "same", { namespace });
    }
    await store.put(["scope", "one"], "same", { updated: true });
    await store.delete(["scope", "one"], "same");

    expect(await store.get(["scope", "one"], "same")).toBeNull();
    for (const namespace of collide.slice(1)) {
      expect((await store.get(namespace, "same"))?.value).toEqual({
        namespace,
      });
    }
    expect(await stored(container.client, "scope.one", "same")).toHaveLength(0);
  });

  it("treats the empty key as a key", async () => {
    await store.put(["empty"], "", { v: 1 });
    await store.put(["empty", "child"], "", { v: 0 });
    await store.put(["empty"], "", { v: 2 });

    expect((await store.get(["empty"], ""))?.value).toEqual({ v: 2 });
    expect(await stored(container.client, "empty", "")).toHaveLength(1);
    expect((await store.get(["empty", "child"], ""))?.value).toEqual({ v: 0 });
  });

  it("reads nothing through an empty or dotted label", async () => {
    await store.put(["dot", "x"], "k", { v: 1 });
    expect(await store.get(["dot.x"], "k")).toBeNull();
    expect(await store.search(["dot.x"])).toEqual([]);
    // [""] joins to the same prefix as [], which searches everything
    expect(await store.search([""])).toEqual([]);
    expect(await store.search([], { limit: 1 })).toHaveLength(1);
  });

  it("pages past candidates that share the key", async () => {
    // The text query cannot narrow these namespaces: each is one label whose
    // words are all stopwords. So every document with the key is a
    // candidate, all score alike, and ties come back in insertion order
    // (oldest first on Redis 7.4, newest first on Redis 8). Ours goes in the
    // middle, on the third page either way.
    const words = ["a", "an", "and", "are", "as", "at", "be", "by", "for"];
    const others = words.flatMap((x) =>
      words.flatMap((y) => words.map((z) => ` ${x} ${y} ${z} `))
    );
    const mine = [" the the the "];
    for (let i = 0; i < 500; i++) {
      if (i === 250) await store.put(mine, "page", { v: "mine" });
      await store.put([others[i]], "page", { v: i });
    }

    const queries = await queriesOf(container.client, async () => {
      expect((await store.get(mine, "page"))?.value).toEqual({ v: "mine" });
    });
    expect(queries).toHaveLength(3);

    await store.put(mine, "page", { v: "again" });
    const docs = await stored(container.client, mine[0], "page");
    expect(docs.map((doc) => doc.value)).toEqual([{ v: "again" }]);
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
      for (const query of [undefined, "near"]) {
        const got = (
          await store.search(namespace, { limit: 1000, query }).catch(() => [])
        ).map((item) => item.namespace.join("."));
        expect(expected).toEqual(expect.arrayContaining(got));
      }
      const item = await store.get(namespace, "k").catch(() => undefined);
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

  it("falls back to the first-word query when Redis rejects the words", async () => {
    await store.put(["memories", "a)"], "mine", { text: "1" });
    let found: Awaited<ReturnType<typeof store.search>> = [];
    const queries = await queriesOf(container.client, async () => {
      found = await store.search(["memories", "a)"], {
        query: "near",
        limit: 100,
      });
    });
    expect(queries).toEqual([
      "(@prefix:(memories a)))=>[KNN 100 @embedding $BLOB]",
      "(@prefix:memories*)=>[KNN 100 @embedding $BLOB]",
    ]);
    expect(found.map((item) => item.key)).toEqual(["mine"]);
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
