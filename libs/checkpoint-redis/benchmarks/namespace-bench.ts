/**
 * Namespace-narrowing benchmark. Seeding uses raw client commands only, so
 * the same dataset is produced regardless of which store.ts is checked out
 * and revisions can be compared directly.
 *
 * Run via benchmarks/run.sh.
 */
import { createClient } from "redis";
import { RedisStore } from "../src/store.js";

const URL = process.env.BENCH_REDIS_URL ?? "redis://127.0.0.1:6399";
const SIZE = Number(process.env.BENCH_SIZE ?? 10000);
const LABEL = process.env.BENCH_LABEL ?? "unknown";
const MAX_ITERS = Number(process.env.BENCH_ITERS ?? 30);
const DIMS = 16;

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vecFor(seedText: string): number[] {
  let h = 0;
  for (const c of seedText) h = (h * 31 + c.charCodeAt(0)) | 0;
  const r = mulberry32(h || 1);
  return Array.from({ length: DIMS }, () => r() * 2 - 1);
}
const embed = {
  async embedDocuments(texts: string[]) {
    return texts.map(vecFor);
  },
};

const DENSE = ["tenant-dense", "notes"];
const SPARSE = ["tenant-sparse", "notes"];
const NONASCII = ["café"];
const HOTKEY = "profile";

type Doc = { prefix: string; key: string };

function composition(n: number): Doc[] {
  const docs: Doc[] = [];
  const dense = Math.floor(n * 0.3);
  const sparse = Math.max(10, Math.floor(n * 0.001));
  const hot = Math.min(5000, Math.floor(n * 0.25));
  for (let i = 0; i < dense; i++)
    docs.push({ prefix: DENSE.join("."), key: `k${i}` });
  for (let i = 0; i < sparse; i++)
    docs.push({ prefix: SPARSE.join("."), key: `k${i}` });
  // Same hot key across many distinct namespaces: worst case for a paging
  // findDocument that must confirm each candidate.
  for (let i = 0; i < hot; i++)
    docs.push({ prefix: `tenant-hot-${i}.notes`, key: HOTKEY });
  for (let i = 0; i < 100; i++)
    docs.push({ prefix: NONASCII.join("."), key: `k${i}` });
  // Deliberate near-collisions: same tokens, different segment boundaries.
  for (let i = 0; i < 100; i++) {
    docs.push({ prefix: "tenant-x.notes", key: `k${i}` });
    docs.push({ prefix: "tenant.x.notes", key: `k${i}` });
    docs.push({ prefix: "notes.tenant-x", key: `k${i}` });
  }
  let i = 0;
  while (docs.length < n)
    docs.push({ prefix: `tenant-${i}.notes`, key: `k${i++}` });
  return docs.slice(0, n);
}

async function seed(client: any, n: number) {
  await client.flushAll();
  const store = new RedisStore(client, {
    index: { dims: DIMS, embed, distanceType: "cosine" },
  });
  await store.setup();
  const docs = composition(n);
  const now = Date.now() * 1000000;
  const BATCH = 500;
  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH);
    await Promise.all(
      chunk.flatMap((d, j) => {
        const id = `d${i + j}`;
        const emb = vecFor(`${d.prefix}/${d.key}`);
        return [
          client.json.set(`store:${id}`, "$", {
            prefix: d.prefix,
            key: d.key,
            value: { n: i + j },
            created_at: now,
            updated_at: now,
          }),
          client.json.set(`store_vectors:${id}`, "$", {
            prefix: d.prefix,
            key: d.key,
            field_name: "text",
            embedding: emb,
            created_at: now,
            updated_at: now,
          }),
        ];
      })
    );
  }
  return docs.length;
}

function pct(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function cell(name: string, fn: () => Promise<any>) {
  let res: any;
  const t = performance.now();
  try {
    res = await fn();
  } catch (e: any) {
    return { name, error: String(e?.message ?? e).slice(0, 120) };
  }
  const probe = performance.now() - t;
  // A single catastrophic call must not hang the matrix.
  const iters = probe > 5000 ? 2 : probe > 500 ? 8 : MAX_ITERS;
  const ds: number[] = [probe];
  for (let i = 1; i < iters; i++) {
    const s = performance.now();
    await fn();
    ds.push(performance.now() - s);
  }
  ds.sort((a, b) => a - b);
  return {
    name,
    n: ds.length,
    p50: +pct(ds, 0.5).toFixed(2),
    p99: +pct(ds, 0.99).toFixed(2),
    check: summarize(res),
  };
}

function summarize(res: any): string {
  if (res === null || res === undefined) return "null";
  if (Array.isArray(res)) {
    const ns = new Set(res.map((r: any) => r.namespace?.join(".")));
    return `${res.length} hits [${[...ns].slice(0, 3).join(" | ")}]`;
  }
  return `hit ${res.namespace?.join(".")}/${res.key}`;
}

async function main() {
  const client = createClient({ url: URL });
  await client.connect();
  const seeded = await seed(client, SIZE);
  const store = new RedisStore(client, {
    index: { dims: DIMS, embed, distanceType: "cosine" },
  });
  await store.setup();

  const cells = [
    await cell("get hit", () => store.get(DENSE, "k0")),
    // "tenant-absent" holds no docs, but HOTKEY exists on thousands of others.
    await cell("get miss hotkey", () =>
      store.get(["tenant-absent", "notes"], HOTKEY)
    ),
    await cell("search dense", () => store.search(DENSE, { limit: 10 })),
    await cell("search sparse", () => store.search(SPARSE, { limit: 10 })),
    await cell("search fallback", () => store.search(NONASCII, { limit: 10 })),
    await cell("search knn sparse", () =>
      store.search(SPARSE, { query: "hello world", limit: 10 })
    ),
  ];

  for (const c of cells) {
    console.log(
      "BENCHJSON " + JSON.stringify({ label: LABEL, size: seeded, ...c })
    );
  }
  await client.quit();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
