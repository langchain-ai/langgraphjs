/**
 * Multi-prefix `namespaces` filter (OR semantics) test against the
 * Python `langgraph-api` server.
 *
 * Server-side ``_matches_subscription`` takes the union over the
 * ``namespaces`` array — each entry is an independent prefix. This
 * script verifies four shapes:
 *
 *   1. Wildcard prefix: `[[]]` matches every namespace (since every
 *      list is a prefix of itself starting at position 0). Proves the
 *      "everything" case.
 *   2. Narrow prefix: `[["fetcher"]]` matches only the fetcher-rooted
 *      branch. Proves the single-prefix case.
 *   3. Overlapping prefixes: `[["fetcher"], ["fetcher", "validator"]]`
 *      where the second is contained in the first — union equals the
 *      first alone, with no double-delivery.
 *   4. Duplicate prefixes: `[["fetcher"], ["fetcher"]]` — proves
 *      duplicates don't multiply event counts.
 *
 * Uses the ``nested_subgraphs`` fixture so we get deterministic
 * namespaces: root → ``fetcher:<uuid>`` → ``validator:<uuid>`` →
 * ``processor:<uuid>`` (linear 3-level chain).
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/multi-namespace.ts
 */

import { Client } from "@langchain/langgraph-sdk";
import type { Event } from "@langchain/protocol";

import { apiUrl, requireServer } from "./_shared.js";

async function driveAndCollect(
  url: string,
  namespaces: string[][]
): Promise<Event[]> {
  const thread = new Client({ apiUrl: url }).threads.stream({
    assistantId: "nested_subgraphs",
  });
  const handle = await thread.subscribe({
    channels: ["lifecycle", "values", "updates"],
    namespaces,
  });

  const collected: Event[] = [];
  const TERMINAL = new Set(["completed", "failed", "interrupted"]);

  const done = new Promise<Event[]>((resolve) => {
    let idle: NodeJS.Timeout | undefined;
    const finish = () => {
      if (idle) clearTimeout(idle);
      handle.close();
      resolve(collected);
    };
    const reset = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, 2500);
    };
    reset();
    (async () => {
      for await (const raw of handle) {
        reset();
        const ev = raw as unknown as Event;
        collected.push(ev);
        const d = ev.params.data as { event?: string } | undefined;
        if (
          ev.method === "lifecycle" &&
          ev.params.namespace.length === 0 &&
          d?.event != null &&
          TERMINAL.has(d.event)
        ) {
          finish();
          return;
        }
      }
      finish();
    })().catch(() => finish());
  });

  await thread.run.start({
    input: { messages: [{ role: "user", content: "drive" }] },
  });
  const events = await done;
  await thread.close();
  return events;
}

function startsWith(namespace: readonly string[], name: string): boolean {
  return namespace.length > 0 && namespace[0].split(":")[0] === name;
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  // --- Case 1: wildcard prefix — `[[]]` matches everything ---
  console.log("--- Case 1: [[]] wildcard prefix ---\n");
  const wildcard = await driveAndCollect(url, [[]]);
  const wildcardDepths = new Set(
    wildcard.map((e) => e.params.namespace.length)
  );
  console.log(`  delivered ${wildcard.length} event(s)`);
  console.log(
    `  namespace depths covered: ${[...wildcardDepths].sort().join(", ")}`
  );
  console.log(
    `assertion — [[]] covers depths 0, 1, 2, and 3: ${
      [0, 1, 2, 3].every((d) => wildcardDepths.has(d)) ? "✓" : "✗"
    }`
  );

  // --- Case 2: narrow prefix — only fetcher branch ---
  console.log('\n--- Case 2: [["fetcher"]] narrow prefix ---\n');
  const fetcher = await driveAndCollect(url, [["fetcher"]]);
  const rootInFetcher = fetcher.filter(
    (e) => e.params.namespace.length === 0
  );
  const nonFetcher = fetcher.filter(
    (e) => e.params.namespace.length > 0 && !startsWith(e.params.namespace, "fetcher")
  );
  console.log(`  delivered ${fetcher.length} event(s)`);
  console.log(
    `  root-namespace events: ${rootInFetcher.length}  (expect 0 — prefix is ["fetcher"])`
  );
  console.log(
    `  non-fetcher-rooted:    ${nonFetcher.length}  (expect 0 — prefix excludes siblings)`
  );
  console.log(
    `assertion — [["fetcher"]] excludes root and siblings: ${
      rootInFetcher.length === 0 && nonFetcher.length === 0 ? "✓" : "✗"
    }`
  );
  console.log(
    `assertion — [["fetcher"]] is strictly narrower than [[]]: ${
      fetcher.length < wildcard.length ? "✓" : `✗ (${fetcher.length} vs ${wildcard.length})`
    }`
  );

  // --- Case 3: overlapping prefixes — one contained in the other ---
  console.log(
    '\n--- Case 3: overlap [["fetcher"], ["fetcher", "validator"]] ---\n'
  );
  const overlap = await driveAndCollect(url, [
    ["fetcher"],
    ["fetcher", "validator"],
  ]);
  console.log(`  delivered ${overlap.length} event(s)`);
  console.log(
    `  [["fetcher"]] alone    ${fetcher.length} event(s) (for reference)`
  );
  console.log(
    `assertion — overlap count equals the wider prefix alone: ${
      overlap.length === fetcher.length
        ? "✓"
        : `✗ (${overlap.length} vs ${fetcher.length})`
    }`
  );
  const overlapIds = overlap
    .map((e) => e.event_id)
    .filter((id): id is string => typeof id === "string");
  const overlapUnique = new Set(overlapIds);
  console.log(
    `assertion — no duplicate event_id from overlapping prefixes: ${
      overlapIds.length === overlapUnique.size ? "✓" : "✗"
    }`
  );

  // --- Case 4: duplicate prefixes ---
  console.log(
    '\n--- Case 4: duplicate [["fetcher"], ["fetcher"]] ---\n'
  );
  const duped = await driveAndCollect(url, [["fetcher"], ["fetcher"]]);
  console.log(
    `  delivered ${duped.length} event(s) (expect ${fetcher.length})`
  );
  const dupedIds = duped
    .map((e) => e.event_id)
    .filter((id): id is string => typeof id === "string");
  const dupedUnique = new Set(dupedIds);
  console.log(
    `assertion — duplicate prefix doesn't change count: ${
      duped.length === fetcher.length ? "✓" : "✗"
    }`
  );
  console.log(
    `assertion — no duplicate event_id from repeated prefix: ${
      dupedIds.length === dupedUnique.size ? "✓" : "✗"
    }`
  );
}

await main();
