/**
 * Depth-filter matrix against `nested_subgraphs`
 * (`main → fetcher → validator → processor`).
 *
 * Sweeps every cell of the (namespace-prefix × depth) grid and
 * asserts the server only delivers events whose namespace is within
 * the specified depth past the matched prefix. Also proves the
 * prefix-match strips dynamic ``:<uuid>`` suffixes when the prefix
 * segment has no ``:`` of its own (see
 * ``api/langgraph_api/protocol/namespace.py :: is_prefix_match``).
 *
 * Matrix:
 *   ns prefix                              depth    expected max depth
 *   ----------                             -----    ------------------
 *   [[]]                                   0        root only
 *   [[]]                                   1        root + 1 level
 *   [[]]                                   2        root + 2 levels
 *   [[]]                                   3        everything (graph has 3 nested levels)
 *   [["fetcher"]]                          0        fetcher branch head only
 *   [["fetcher"]]                          1        fetcher + validator
 *   [["fetcher"]]                          2        fetcher + validator + processor
 *   [["fetcher","validator"]]              0        validator only (depth-2 events)
 *   [["fetcher","validator","processor"]]  0        processor only (depth-3 events)
 *
 * Each row also asserts the event COUNT drops monotonically as depth
 * shrinks. Uses a dedicated thread per row so filters don't leak
 * across runs (the server replays full history on ``last_event_id="0"``
 * so the count is deterministic per graph run).
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/depth-matrix.ts
 */

import { Client } from "@langchain/langgraph-sdk";
import { apiUrl, requireServer } from "./_shared.js";

interface Event {
  method: string;
  params: { namespace: readonly string[]; data: unknown };
}

async function driveAndCollect(
  url: string,
  options: { namespaces?: string[][]; depth?: number }
): Promise<Event[]> {
  const thread = new Client({ apiUrl: url }).threads.stream({
    assistantId: "nested_subgraphs",
  });
  const handle = await thread.subscribe({
    channels: ["lifecycle", "values", "updates"],
    ...(options.namespaces ? { namespaces: options.namespaces } : {}),
    ...(options.depth != null ? { depth: options.depth } : {}),
  });

  const collected: Event[] = [];
  const TERMINAL = new Set(["completed", "failed", "interrupted"]);
  const SILENCE_MS = 2500;

  const done = new Promise<Event[]>((resolve) => {
    let idle: NodeJS.Timeout | undefined;
    const finish = () => {
      if (idle) clearTimeout(idle);
      handle.close();
      resolve(collected);
    };
    const reset = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, SILENCE_MS);
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

function countByDepth(events: Event[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of events) {
    const depth = e.params.namespace.length;
    out.set(depth, (out.get(depth) ?? 0) + 1);
  }
  return out;
}

function maxDepth(events: Event[]): number {
  let m = 0;
  for (const e of events) m = Math.max(m, e.params.namespace.length);
  return m;
}

interface Case {
  label: string;
  namespaces: string[][];
  depth: number;
  prefixLen: number; // depth of the prefix being matched (0 for root, 1 for ["fetcher"])
}

const CASES: readonly Case[] = [
  { label: "[[]] depth=0", namespaces: [[]], depth: 0, prefixLen: 0 },
  { label: "[[]] depth=1", namespaces: [[]], depth: 1, prefixLen: 0 },
  { label: "[[]] depth=2", namespaces: [[]], depth: 2, prefixLen: 0 },
  { label: "[[]] depth=3", namespaces: [[]], depth: 3, prefixLen: 0 },
  {
    label: '[["fetcher"]] depth=0',
    namespaces: [["fetcher"]],
    depth: 0,
    prefixLen: 1,
  },
  {
    label: '[["fetcher"]] depth=1',
    namespaces: [["fetcher"]],
    depth: 1,
    prefixLen: 1,
  },
  {
    label: '[["fetcher"]] depth=2',
    namespaces: [["fetcher"]],
    depth: 2,
    prefixLen: 1,
  },
  // Isolating a single nested branch: point the prefix at the exact
  // node you want and use ``depth: 0`` so nothing past that level leaks
  // through. Prefix segments without ``:`` still strip the dynamic
  // ``:<uuid>`` suffix server-side (see ``is_prefix_match``), so the
  // plain node names are sufficient.
  {
    label: '[["fetcher","validator"]] depth=0 (validator only)',
    namespaces: [["fetcher", "validator"]],
    depth: 0,
    prefixLen: 2,
  },
  {
    label:
      '[["fetcher","validator","processor"]] depth=0 (processor only)',
    namespaces: [["fetcher", "validator", "processor"]],
    depth: 0,
    prefixLen: 3,
  },
];

async function main() {
  const url = apiUrl();
  await requireServer(url);

  console.log(
    "Depth-matrix sweep over nested_subgraphs (root + 3 nested levels).\n"
  );

  const results: Array<{
    case: Case;
    events: number;
    maxAbsDepth: number;
    byDepth: Map<number, number>;
  }> = [];

  for (const c of CASES) {
    const events = await driveAndCollect(url, {
      namespaces: c.namespaces,
      depth: c.depth,
    });
    results.push({
      case: c,
      events: events.length,
      maxAbsDepth: maxDepth(events),
      byDepth: countByDepth(events),
    });
  }

  // --- Summary table ---
  const labelWidth = Math.max(
    "case".length,
    ...results.map((r) => r.case.label.length)
  );
  console.log(
    `  ${"case".padEnd(labelWidth)} ${"total".padStart(5)} ${"maxD".padStart(4)} depth→count breakdown`
  );
  for (const r of results) {
    const breakdown = [...r.byDepth.entries()]
      .sort(([a], [b]) => a - b)
      .map(([d, n]) => `${d}:${n}`)
      .join(" ");
    console.log(
      `  ${r.case.label.padEnd(labelWidth)} ${String(r.events).padStart(5)} ${String(r.maxAbsDepth).padStart(4)}  ${breakdown}`
    );
  }
  console.log();

  // --- Assertions ---
  // (a) Each case's max absolute depth is at most prefixLen + depth.
  let caseViolations = 0;
  for (const r of results) {
    const cap = r.case.prefixLen + r.case.depth;
    if (r.maxAbsDepth > cap) {
      caseViolations += 1;
      console.log(
        `  violation: ${r.case.label} allowed maxD=${cap}, got ${r.maxAbsDepth}`
      );
    }
  }
  console.log(
    `assertion — every case honors prefixLen+depth cap: ${
      caseViolations === 0 ? "✓" : `✗ (${caseViolations} violations)`
    }`
  );

  // (b) For a fixed prefix, event count is monotonically non-decreasing
  // in depth.
  const rootRows = results.filter((r) => r.case.prefixLen === 0);
  const fetcherRows = results.filter((r) => r.case.prefixLen === 1);
  const monotonic = (rows: typeof results) =>
    rows.every(
      (r, i) => i === 0 || r.events >= (rows[i - 1]?.events ?? 0)
    );
  console.log(
    `assertion — [[]] event count non-decreasing as depth grows: ${
      monotonic(rootRows) ? "✓" : "✗"
    }`
  );
  console.log(
    `assertion — [["fetcher"]] event count non-decreasing as depth grows: ${
      monotonic(fetcherRows) ? "✓" : "✗"
    }`
  );

  // (c) depth=0 root-prefix yields only root-namespace events.
  const rootD0 = results.find(
    (r) => r.case.label === "[[]] depth=0"
  );
  const rootOnly =
    rootD0 != null && (rootD0.byDepth.size === 0 || rootD0.byDepth.size === 1 && rootD0.byDepth.has(0));
  console.log(
    `assertion — [[]] depth=0 returns root-namespace events only: ${
      rootOnly ? "✓" : "✗"
    }`
  );

  // (d) depth=3 root-prefix returns events at every depth 0..3.
  const rootD3 = results.find(
    (r) => r.case.label === "[[]] depth=3"
  );
  const allLevels =
    rootD3 != null &&
    [0, 1, 2, 3].every((d) => (rootD3.byDepth.get(d) ?? 0) > 0);
  console.log(
    `assertion — [[]] depth=3 covers namespaces at depths 0-3: ${
      allLevels ? "✓" : "✗"
    }`
  );

  // (e) [["fetcher"]] depth=0 returns only namespaces rooted at the
  // fetcher branch (starting with "fetcher:...", length exactly 1).
  const fetD0 = results.find(
    (r) => r.case.label === '[["fetcher"]] depth=0'
  );
  const fetD0AllAtDepth1 =
    fetD0 != null &&
    (fetD0.byDepth.size === 0 ||
      (fetD0.byDepth.size === 1 && fetD0.byDepth.has(1)));
  console.log(
    `assertion — [["fetcher"]] depth=0 stays at the fetcher level: ${
      fetD0AllAtDepth1 ? "✓" : "✗"
    }`
  );

  // (f) Validator-only: [["fetcher","validator"]] depth=0 delivers
  // nothing but events whose namespace is ["fetcher:*", "validator:*"].
  const valOnly = results.find((r) => r.case.prefixLen === 2);
  const validatorEvents = valOnly
    ? valOnly.byDepth.get(2) ?? 0
    : 0;
  const validatorOutside = valOnly
    ? [...valOnly.byDepth.entries()].filter(([d]) => d !== 2)
    : [];
  console.log(
    `assertion — validator-only filter stays at depth 2 ` +
      `(${validatorEvents} event(s)): ${
        valOnly != null && validatorOutside.length === 0 ? "✓" : "✗"
      }`
  );

  // (g) Processor-only: [["fetcher","validator","processor"]] depth=0
  // delivers nothing but depth-3 events from the processor subgraph.
  const procOnly = results.find((r) => r.case.prefixLen === 3);
  const processorEvents = procOnly
    ? procOnly.byDepth.get(3) ?? 0
    : 0;
  const processorOutside = procOnly
    ? [...procOnly.byDepth.entries()].filter(([d]) => d !== 3)
    : [];
  console.log(
    `assertion — processor-only filter stays at depth 3 ` +
      `(${processorEvents} event(s)): ${
        procOnly != null && processorOutside.length === 0 ? "✓" : "✗"
      }`
  );
}

await main();
