/**
 * Measures how RediSearch cuts a TEXT field into terms, which is the model
 * `namespaceCandidateQuery` in ../src/store.ts relies on. Each row indexes one
 * document and reports how many documents each candidate term matches: 1 means
 * the term was indexed as written, 0 means it never existed and a query built
 * from it would silently match nothing.
 *
 * Risky characters are built with String.fromCharCode so this file stays free
 * of literal control characters.
 *
 * Needs Redis 8 with RediSearch on BENCH_REDIS_URL (default port 6399).
 */
import { createClient } from "redis";

const URL = process.env.BENCH_REDIS_URL ?? "redis://127.0.0.1:6399";
const ch = String.fromCharCode;
const LF = ch(10);
const CR = ch(13);
const BSL = ch(92);
const SOH = ch(1);
const DEL = ch(127);

/** [what it demonstrates, indexed value, terms to probe for] */
const CASES: Array<[string, string, string[]]> = [
  ["hyphen separates", "naive-notes", ["naive", "notes"]],
  ["space separates", "two words", ["two", "words"]],
  ["slash separates", "a/b", ["b"]],
  ["underscore does not", "under_score", ["under_score", "under", "score"]],
  ["backslash fuses", `c/d${BSL}ef`, ["c", "def", "d", "ef"]],
  ["newline fuses", `g/h${LF}ij`, ["g", "hij", "h", "ij"]],
  ["carriage return fuses", `k/l${CR}mn`, ["k", "lmn", "l", "mn"]],
  ["control char fuses", `o/p${SOH}qr`, ["o", "pqr", "p", "qr"]],
  ["delete char fuses", `s/t${DEL}uv`, ["s", "tuv", "t", "uv"]],
  ["accented is content", "café", ["café"]],
  ["cjk is content", "日本語", ["日本語"]],
  ["symbol is content", "a€b", ["a€b", "a", "b"]],
  ["astral is content", "a\u{1f600}b", ["a\u{1f600}b", "b"]],
  ["punctuation still cuts", "preé-post", ["preé", "post"]],
  // "the" is a default stopword. Every query here also carries the document
  // marker, so "the"=1 shows the stopword being ignored rather than matching.
  ["stopword ignored", "the-report", ["report", "the report", "the"]],
  // Terms intersect, so one unindexed term makes the whole query match zero.
  ["terms intersect", "alpha-beta", ["alpha beta", "alpha nosuchterm"]],
];

const client = createClient({ url: URL });
await client.connect();
await client.flushAll();
await client.ft.create(
  "probe",
  { "$.prefix": { type: "TEXT", AS: "prefix" } } as never,
  { ON: "JSON", PREFIX: "probe:" }
);

let id = 0;
for (const [, value] of CASES) {
  await client.json.set(`probe:${id}`, "$", { prefix: `d${id}.${value}` });
  id += 1;
}

id = 0;
for (const [what, value, terms] of CASES) {
  const results: string[] = [];
  for (const term of terms) {
    // Space-separated terms intersect, so pairing with the unique document
    // marker "dN" keeps a term indexed by some other case from counting here.
    const hits = await client.ft.search("probe", `@prefix:(d${id} ${term})`, {
      LIMIT: { from: 0, size: 0 },
    });
    results.push(`${JSON.stringify(term)}=${hits.total}`);
  }
  id += 1;
  console.log(
    what.padEnd(24) + JSON.stringify(value).padEnd(20) + results.join("  ")
  );
}

// Unscoped, so nothing else can satisfy the query: a stopword on its own is
// not ignored but matches nothing, which is why no-usable-term falls back to "*".
const alone = await client.ft.search("probe", "@prefix:(the)", {
  LIMIT: { from: 0, size: 0 },
});
console.log(
  `${"stopword alone".padEnd(24)}${'"@prefix:(the)"'.padEnd(20)}total=${alone.total}`
);

await client.quit();
