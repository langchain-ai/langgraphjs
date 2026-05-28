/**
 * Nested subgraph namespace + filter coverage against the Python
 * `langgraph-api` server.
 *
 * Drives `nested_subgraphs`, a 3-level deep fixture graph
 * (`main → fetcher → validator → processor`). The run ripples through
 * every level, and the server emits a `lifecycle.started` event for
 * each new subgraph namespace plus `values` / `updates` events scoped
 * to those namespaces.
 *
 * What this exercises on the server:
 *
 *   - Subgraph namespace discovery: every new descendant namespace
 *     seen by a session gets a `lifecycle.started` event synthesized
 *     by `_ensure_namespaces`.
 *   - Prefix-match semantics on the `namespaces` filter: subgraph
 *     segments are emitted as `"<node>:<uuid>"`; a prefix without `:`
 *     strips the dynamic UUID suffix before comparing (see
 *     `protocol.namespace.is_prefix_match`). So `namespaces: [["fetcher"]]`
 *     correctly matches `["fetcher:abc", …]`.
 *   - Composite `namespaces + depth` filter: `depth` is interpreted
 *     server-side as "N levels past the matched prefix". Passing
 *     `namespaces: [[]]` (root prefix) with `depth: 1` delivers only
 *     root + first-level subgraphs.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/subgraphs.ts
 */

import { Client } from "@langchain/langgraph-sdk";
import type { Event } from "@langchain/protocol";

import { apiUrl, requireServer } from "./_shared.js";

type NamespaceKey = string;

function nsKey(namespace: readonly string[]): NamespaceKey {
  return namespace.length === 0 ? "(root)" : namespace.join(" / ");
}

async function drainSubscription(
  thread: ReturnType<Client["threads"]["stream"]>,
  channels: readonly ("lifecycle" | "values" | "updates")[],
  options: {
    namespaces?: readonly (readonly string[])[];
    depth?: number;
    silenceMs?: number;
  },
  maxEvents: number
): Promise<Event[]> {
  const { silenceMs = 1500 } = options;
  const handle = await thread.subscribe({
    channels: [...channels],
    ...(options.namespaces
      ? { namespaces: options.namespaces as unknown as string[][] }
      : {}),
    ...(options.depth != null ? { depth: options.depth } : {}),
  });
  const collected: Event[] = [];
  const TERMINAL_LIFECYCLE_EVENTS = new Set([
    "completed",
    "failed",
    "interrupted",
  ]);

  // Filtered subscriptions can drop the root-namespace terminal
  // lifecycle (e.g. ``namespaces: [["fetcher"]]`` never matches a
  // root lifecycle event). Fall back to a silence-based cutoff so the
  // drain returns when the run has been quiet for ``silenceMs``.
  const result = await new Promise<Event[]>((resolve) => {
    let idle: NodeJS.Timeout | undefined;
    const finish = () => {
      if (idle) clearTimeout(idle);
      handle.close();
      resolve(collected);
    };
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, silenceMs);
    };
    (async () => {
      for await (const raw of handle) {
        resetIdle();
        const event = raw as Event;
        collected.push(event);
        if (collected.length >= maxEvents) {
          finish();
          return;
        }
        const data = event.params.data as { event?: string } | undefined;
        if (
          event.method === "lifecycle" &&
          event.params.namespace.length === 0 &&
          data?.event != null &&
          TERMINAL_LIFECYCLE_EVENTS.has(data.event)
        ) {
          finish();
          return;
        }
      }
      finish();
    })().catch(() => finish());
  });
  return result;
}

async function runOnce(
  url: string,
  label: string,
  options: { namespaces?: readonly (readonly string[])[]; depth?: number }
): Promise<Event[]> {
  console.log(`\n=== ${label} ===\n`);
  const thread = new Client({ apiUrl: url }).threads.stream({
    assistantId: "nested_subgraphs",
  });
  const collectorPromise = drainSubscription(
    thread,
    ["lifecycle", "values", "updates"],
    options,
    120
  );
  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "drive nested subgraphs" }],
    },
  });
  const events = await collectorPromise;
  await thread.close();
  return events;
}

function summarizeByNamespace(events: Event[]): void {
  const perNs = new Map<NamespaceKey, { methods: Set<string>; count: number }>();
  for (const event of events) {
    const key = nsKey(event.params.namespace);
    const bucket =
      perNs.get(key) ?? { methods: new Set<string>(), count: 0 };
    bucket.methods.add(event.method);
    bucket.count += 1;
    perNs.set(key, bucket);
  }
  const rows = [...perNs.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(
    `delivered ${events.length} event(s) across ${rows.length} namespace(s):`
  );
  for (const [ns, { methods, count }] of rows) {
    console.log(
      `  ${ns.padEnd(60)} ${String(count).padStart(3)}  (${[...methods]
        .sort()
        .join(", ")})`
    );
  }
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  // 1. Baseline — no filters. Every namespace shows up.
  const full = await runOnce(url, "full subscription (no filter)", {});
  summarizeByNamespace(full);
  const rootLifecycleCount = full.filter(
    (e) => e.method === "lifecycle" && e.params.namespace.length === 0
  ).length;
  const subgraphLifecycleCount = full.filter(
    (e) => e.method === "lifecycle" && e.params.namespace.length > 0
  ).length;
  console.log(
    `assertion — saw ${subgraphLifecycleCount} subgraph lifecycle event(s) ` +
      `(expect >= 3, one per nesting level): ${
        subgraphLifecycleCount >= 3 ? "✓" : "✗"
      }`
  );
  console.log(
    `assertion — saw ${rootLifecycleCount} root lifecycle event(s) ` +
      `(expect >= 2, running + completed): ${
        rootLifecycleCount >= 2 ? "✓" : "✗"
      }`
  );

  // 2. depth filter — scoped to the root prefix. ``depth: 1`` means
  // "the root plus one nesting level past it", so we see root + the
  // immediate ``fetcher:*`` namespace but not the ``validator:*`` /
  // ``processor:*`` levels below.
  const shallow = await runOnce(
    url,
    "namespaces: [[]] + depth: 1 (root + one level)",
    { namespaces: [[]], depth: 1 }
  );
  summarizeByNamespace(shallow);
  const tooDeep = shallow.filter((e) => e.params.namespace.length > 1);
  console.log(
    `assertion — no event with namespace depth > 1: ${
      tooDeep.length === 0 ? "✓" : `✗ (${tooDeep.length} leaked through)`
    }`
  );

  // 3. namespaces prefix filter — the server's `is_prefix_match`
  // strips the dynamic ``:<uuid>`` suffix when the prefix segment has
  // no ``:`` of its own, so we can filter by node name alone.
  const filtered = await runOnce(
    url,
    'namespaces: [["fetcher"]] (prefix-match strips ":uuid" suffix)',
    { namespaces: [["fetcher"]] }
  );
  summarizeByNamespace(filtered);
  const outsideBranch = filtered.filter(
    (e) =>
      e.params.namespace.length > 0 &&
      !e.params.namespace[0].startsWith("fetcher")
  );
  const rootLeaked = filtered.filter((e) => e.params.namespace.length === 0);
  console.log(
    `assertion — no event from a sibling branch: ${
      outsideBranch.length === 0
        ? "✓"
        : `✗ (${outsideBranch.length} leaked through)`
    }`
  );
  console.log(
    `assertion — no root-namespace event leaked: ${
      rootLeaked.length === 0
        ? "✓"
        : `✗ (${rootLeaked.length} leaked through)`
    }`
  );
}

await main();
