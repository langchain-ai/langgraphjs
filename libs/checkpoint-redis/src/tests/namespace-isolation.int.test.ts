import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { documentQuery } from "../namespace.js";
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

/** Wait for Redis to finish indexing existing documents. */
async function indexed(client: Client, name: string) {
  await vi.waitFor(
    async () => {
      const info = (await client.sendCommand(["FT.INFO", name])) as unknown[];
      expect(Number(info[info.indexOf("indexing") + 1])).toBe(0);
    },
    { timeout: 60_000, interval: 50 }
  );
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
  // setup() ran, so queries use the namespace fields.
  let labelled: RedisStore;
  // setup() never ran, so queries use the text match of earlier versions.
  let plain: RedisStore;

  beforeAll(async () => {
    container = await createRedisContainer();
    labelled = new RedisStore(container.client, { index });
    await labelled.setup();
    plain = new RedisStore(container.client, { index });
  }, 120_000);

  afterAll(async () => {
    await container?.cleanup();
  });

  it("uses the namespace fields only once setup() has added them", async () => {
    const { client } = container;
    expect(
      await queriesOf(client, () => labelled.get(["q", "a"], "k"))
    ).toEqual(["@prefix_exact:{$ns} @key:{$key}"]);
    expect(await queriesOf(client, () => plain.get(["q", "a"], "k"))).toEqual([
      "(@prefix:(q a)) (@key:{k})",
    ]);

    const alter = vi.spyOn(client.ft, "alter");
    const another = new RedisStore(client, { index });
    await another.setup();
    expect(alter).not.toHaveBeenCalled();
    alter.mockRestore();
    const [query] = await queriesOf(client, () => another.search(["q"]));
    expect(query).toBe("@prefix_labels:{$l0}");
  });

  it("has Redis return only the namespace's own document", async () => {
    const namespaces = [
      ["exact", "a"],
      ["a", "exact"],
      ["exact", "A"],
      ["exact", "a-b"],
      ["exact", "a", "b"],
      ["exact", " padded "],
      ["exact", "tab\tthere"],
      ["exact", "x".repeat(5000)],
      ["exact", "a) | @prefix:(victim"],
      ["exact", "back\\!slash"],
      ["exact", "*"],
    ];
    for (const namespace of namespaces) {
      await labelled.put(namespace, "k", { namespace });
    }
    for (const namespace of namespaces) {
      const { query, params } = documentQuery(namespace, "k");
      const found = await container.client.ft.search("store", query, {
        PARAMS: params,
        DIALECT: 2,
      });
      expect(
        found.documents.map((doc: any) => doc.value.prefix),
        JSON.stringify(namespace)
      ).toEqual([namespace.join(".")]);
    }
  });

  const paths: [string, () => RedisStore][] = [
    ["labels", () => labelled],
    ["text", () => plain],
  ];
  describe.each(paths)("through the %s query", (path, store) => {
    const t = `tenant${path}`;
    // The text query can miss documents, as it always could: a stopword
    // label is not indexed. It must never return another namespace's.
    const complete = path !== "text";

    it("reads and searches only the namespace asked for", async () => {
      const namespaces = [
        [t, "a"],
        [t, "a", "notes"],
        [t, "ab"],
        ["a", t],
        [t, "A"],
        [t, "a-b"],
        [t, "a) | @prefix:(victim"],
        // Longer than a tag can hold
        [t, "x".repeat(5000)],
      ];
      for (const [i, namespace] of namespaces.entries()) {
        await store().put(namespace, `key${i}`, { text: String(i) });
      }
      for (const [i, namespace] of namespaces.entries()) {
        expect((await store().get(namespace, `key${i}`))?.namespace).toEqual(
          namespace
        );
        expect(
          await store().get(namespace, `key${(i + 1) % namespaces.length}`)
        ).toBeNull();
        for (const query of [undefined, "near"]) {
          const found = await store().search(namespace, { limit: 50, query });
          const expected = namespaces.filter((other) =>
            namespace.every((label, j) => other[j] === label)
          );
          const namespacesFound = found.map((item) => item.namespace);
          expect(expected).toEqual(expect.arrayContaining(namespacesFound));
          if (complete) {
            expect(namespacesFound).toHaveLength(expected.length);
          }
        }
      }
    });

    it("replaces and deletes only the exact namespace", async () => {
      const collide = [
        [t, "one"],
        ["one", t],
        [t, "one", "child"],
        [t, "One"],
      ];
      for (const namespace of collide) {
        await store().put(namespace, "same", { namespace });
      }
      await store().put([t, "one"], "same", { updated: true });
      await store().delete([t, "one"], "same");

      expect(await store().get([t, "one"], "same")).toBeNull();
      for (const namespace of collide.slice(1)) {
        expect((await store().get(namespace, "same"))?.value).toEqual({
          namespace,
        });
      }
      expect(await stored(container.client, `${t}.one`, "same")).toHaveLength(
        0
      );
    });

    it("treats the empty key as a key", async () => {
      await store().put([t, "empty"], "", { v: 1 });
      await store().put([t, "empty", "child"], "", { v: 0 });
      await store().put([t, "empty"], "", { v: 2 });

      expect((await store().get([t, "empty"], ""))?.value).toEqual({ v: 2 });
      expect(await stored(container.client, `${t}.empty`, "")).toHaveLength(1);
      expect((await store().get([t, "empty", "child"], ""))?.value).toEqual({
        v: 0,
      });
    });

    it("reads nothing through an empty or dotted label", async () => {
      await store().put([t, "dot", "x"], "k", { v: 1 });
      expect(await store().get([`${t}.dot`, "x"], "k")).toBeNull();
      expect(await store().search([`${t}.dot`])).toEqual([]);
      // [""] joins to the same prefix as [], which searches everything
      expect(await store().search([""])).toEqual([]);
      expect(await store().search([], { limit: 1 })).toHaveLength(1);
    });

    it("pages past candidates that share the key", async () => {
      // The text query cannot narrow these namespaces: each is one label
      // whose words are all stopwords. So every document with the key is a
      // candidate, all score alike, and ties come back in insertion order
      // (oldest first on Redis 7.4, newest first on Redis 8). Ours goes in
      // the middle, on the third page either way. The exact field needs one.
      const key = `page${path}`;
      const words = ["a", "an", "and", "are", "as", "at", "be", "by", "for"];
      const others = words.flatMap((x) =>
        words.flatMap((y) => words.map((z) => ` ${x} ${y} ${z} `))
      );
      const mine = [" the the the "];
      for (let i = 0; i < 500; i++) {
        if (i === 250) await store().put(mine, key, { v: "mine" });
        await store().put([others[i]], key, { v: i });
      }

      const queries = await queriesOf(container.client, async () => {
        expect((await store().get(mine, key))?.value).toEqual({ v: "mine" });
      });
      expect(queries).toHaveLength(path === "text" ? 3 : 1);

      await store().put(mine, key, { v: "again" });
      const docs = await stored(container.client, mine[0], key);
      expect(docs.map((doc) => doc.value)).toEqual([{ v: "again" }]);
    });

    it("keeps random hostile namespaces apart", async () => {
      const rnd = random(path === "text" ? 12 : 11);
      const pool = [
        ..."abzAZ09_",
        ...["a", "is", "the", " ", "\t", "\n", "\\", "|", "{", "}", "(", ")"],
        ...['"', "'", "*", "~", "-", ":", "@", "%", "$", "`", "é", "日"],
        ...[String.fromCharCode(0), "x".repeat(5000)],
      ];
      const label = () =>
        Array.from({ length: 1 + rnd(4) }, () => pool[rnd(pool.length)]).join(
          ""
        );
      const flats = new Set<string>();
      const made: string[][] = [];
      while (made.length < 120) {
        const namespace = [
          `fz${path}`,
          ...Array.from({ length: 1 + rnd(2) }, label),
        ];
        const flat = namespace.join(".");
        if (
          namespace.some((l) => l === "" || l.includes(".")) ||
          flats.has(flat)
        ) {
          continue;
        }
        flats.add(flat);
        made.push(namespace);
        await store().put(namespace, "k", { flat });
      }

      for (const namespace of made) {
        const flat = namespace.join(".");
        const expected = [...flats].filter(
          (other) => other === flat || other.startsWith(`${flat}.`)
        );
        // The text query rejects some of these labels as a syntax error, as
        // it always did.
        const tolerate = (error: unknown) => {
          if (complete) throw error;
        };
        const got = (
          (await store().search(namespace, { limit: 1000 }).catch(tolerate)) ??
          []
        ).map((item) => item.namespace.join("."));
        const item = await store().get(namespace, "k").catch(tolerate);
        // Every result belongs to the namespace, on either path.
        expect(expected).toEqual(expect.arrayContaining(got));
        expect([undefined, null, flat]).toContain(item?.value.flat ?? item);
        if (complete) {
          // And it finds everything that is there.
          expect(got.sort(), JSON.stringify(namespace)).toEqual(
            expected.sort()
          );
          expect(item?.value).toEqual({ flat });
        }
      }
    });
  });

  it("finds a vector behind nearer ones from other namespaces", async () => {
    for (let i = 0; i < 1200; i++) {
      await labelled.put(["knn", "A"], `f${i}`, { text: String(i / 10) });
    }
    await labelled.put(["knn", "a"], "mine", { text: "900" });
    const [found] = await labelled.search(["knn", "a"], {
      query: "near",
      limit: 1,
    });
    expect(found?.key).toBe("mine");
  });
});

/** A document exactly as earlier versions write it, in namespace `old.<label>`. */
function legacy(label: string, key: string, v: string | number) {
  return {
    prefix: `old.${label}`,
    key,
    value: { v },
    created_at: 1,
    updated_at: 1,
  };
}

describe("upgrading a store written by an earlier version", () => {
  let container: Awaited<ReturnType<typeof createRedisContainer>>;
  const count = 50_000;

  beforeAll(async () => {
    container = await createRedisContainer();
    const { client } = container;
    // The index and documents exactly as earlier versions write them.
    await client.ft.create(
      "store",
      {
        "$.prefix": { type: "TEXT", AS: "prefix" },
        "$.key": { type: "TAG", AS: "key" },
        "$.created_at": { type: "NUMERIC", AS: "created_at" },
        "$.updated_at": { type: "NUMERIC", AS: "updated_at" },
      } as any,
      { ON: "JSON", PREFIX: "store:" }
    );
    for (let from = 0; from < count; from += 5000) {
      const batch = client.multi();
      for (let i = from; i < from + 5000; i++) {
        batch.json.set(`store:old${i}`, "$", legacy(`n${i}`, `k${i}`, i));
      }
      await batch.exec();
    }
    await indexed(client, "store");
  }, 180_000);

  afterAll(async () => {
    await container?.cleanup();
  });

  it.each([
    ["any field", () => true],
    ["one of the fields", (as: string) => as === "prefix_exact"],
  ])("keeps the text query when Redis refuses %s", async (_, refuse) => {
    const { client } = container;
    const alter = client.ft.alter.bind(client.ft) as (...args: any[]) => any;
    const refusing = vi
      .spyOn(client.ft, "alter")
      .mockImplementation(((index: string, schema: any) =>
        refuse(schema["$.prefix"].AS)
          ? Promise.reject(new Error("NOPERM this user has no permissions"))
          : alter(index, schema)) as any);
    const refused = new RedisStore(client);
    await expect(refused.setup()).resolves.toBeUndefined();
    refusing.mockRestore();

    // Even once Redis has indexed what it added, the store must not use it
    await indexed(client, "store");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const queries = await queriesOf(client, async () => {
      expect((await refused.get(["old", "n7"], "k7"))?.value).toEqual({ v: 7 });
    });
    expect(queries).toEqual(["(@prefix:(old n7)) (@key:{k7})"]);
  });

  it("switches to the namespace fields once Redis has indexed them", async () => {
    const { client } = container;
    const before = await client.json.get("store:old42");
    const store = new RedisStore(client);
    await store.setup();

    // Redis is still indexing the new fields: a query on them would miss
    // older documents, so an update must still find the one it replaces.
    const during = await queriesOf(client, async () => {
      await store.put(["old", "n7"], "k7", { v: "new" });
      expect((await store.get(["old", "n9"], "k9"))?.value).toEqual({ v: 9 });
    });
    expect(during.every((query) => query.startsWith("(@prefix:("))).toBe(true);

    await indexed(client, "store");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const after = await queriesOf(client, async () => {
      expect((await store.get(["old", "n7"], "k7"))?.value).toEqual({
        v: "new",
      });
      expect((await store.get(["old", "n42"], "k42"))?.value).toEqual({
        v: 42,
      });
    });
    expect(after).toEqual([
      "@prefix_exact:{$ns} @key:{$key}",
      "@prefix_exact:{$ns} @key:{$key}",
    ]);
    expect(await stored(client, "old.n7", "k7")).toHaveLength(1);
    // Reads leave older documents as they were.
    expect(await client.json.get("store:old42")).toEqual(before);

    // A document an earlier version writes now is found through the fields.
    await client.json.set("store:late", "$", legacy("late", "late", "late"));
    expect((await store.get(["old", "late"], "late"))?.value).toEqual({
      v: "late",
    });
  });
});
