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
  let plain: RedisStore;

  beforeAll(async () => {
    container = await createRedisContainer();
    plain = new RedisStore(container.client, { index });
    await plain.setup();
  }, 120_000);

  afterAll(async () => {
    await container?.cleanup();
  });

  const paths: [string, () => RedisStore][] = [["text", () => plain]];
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

    it("reads nothing through a dotted label", async () => {
      await store().put([t, "dot", "x"], "k", { v: 1 });
      expect(await store().get([`${t}.dot`, "x"], "k")).toBeNull();
      expect(await store().search([`${t}.dot`])).toEqual([]);
    });

    it("pages past candidates that share the key", async () => {
      // Neither query narrows these namespaces: each is one label with edge
      // spaces, whose words are all stopwords. So every document with the
      // key is a candidate, all score alike, and ties come back in insertion
      // order (oldest first on Redis 7.4, newest first on Redis 8). Ours goes
      // in the middle, on the third page either way.
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
      expect(queries).toHaveLength(3);

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
});
