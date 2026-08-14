import { it, describe, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation, StateGraph } from "../graph/index.js";
import { START, END, Send } from "../constants.js";

// Seeded property tests for inclusive waiting edges: random combinations of
// conditional entry subsets, chains of different depths, a bounded loop, a
// Send dispatcher, and one or two waiting edges (inclusive or default), all
// deterministic per seed so a failure is reproducible by its seed alone.
//
// Invariants:
//   I1 — a completed run leaves no inclusive edge holding writes.
//   I4 — where no listed node can arrive twice, an inclusive target runs
//        exactly once iff any listed node ran; where a node has two trigger
//        paths, the count is bounded by the possible arrivals (each arrival
//        re-arms the edge — the barrier's own accumulation rule).
//   Resume — an interrupted run, resumed until `next` is empty, produces the
//        same node multiset as the uninterrupted run.

const mulberry32 = (seed: number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const State = Annotation.Root({
  ran: Annotation<string[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
});

type Spec = {
  seed: number;
  workers: string[];
  entrySubset: string[];
  chains: Array<[string, string]>;
  loopFrom: string | undefined;
  loopTo: string | undefined;
  loopPasses: number;
  sendFrom: string | undefined;
  sendTo: string | undefined;
  joins: Array<{ target: string; sources: string[]; inclusive: boolean }>;
};

const genSpec = (seed: number): Spec => {
  const r = mulberry32(seed);
  const workerCount = 3 + Math.floor(r() * 4);
  const workers = Array.from({ length: workerCount }, (_, i) => `w${i}`);

  const entrySubset = workers.filter(() => r() < 0.55);
  if (entrySubset.length === 0) entrySubset.push(workers[0]);

  const chains: Array<[string, string]> = [];
  for (let i = 0; i < workerCount - 1; i += 1) {
    if (r() < 0.4) {
      const j = i + 1 + Math.floor(r() * (workerCount - i - 1));
      chains.push([workers[i], workers[j]]);
    }
  }

  // a bounded loop with a random re-entry point and pass count: `loopFrom`
  // routes back to `loopTo` until it has itself run `loopPasses` times
  const loopFrom = r() < 0.3 ? workers[workerCount - 1] : undefined;
  const loopTo = loopFrom
    ? workers[Math.floor(r() * (workerCount - 1))]
    : undefined;
  const loopPasses = 2 + (r() < 0.4 ? 1 : 0);

  const sendFrom = r() < 0.3 ? workers[0] : undefined;
  const sendTo = sendFrom
    ? workers[1 + Math.floor(r() * (workerCount - 1))]
    : undefined;

  const joins: Spec["joins"] = [];
  const joinCount = 1 + (r() < 0.4 ? 1 : 0);
  for (let j = 0; j < joinCount; j += 1) {
    const pool = [...workers].sort(() => r() - 0.5);
    const size = 2 + (r() < 0.4 ? 1 : 0);
    joins.push({
      target: `j${j}`,
      sources: pool.slice(0, size),
      inclusive: r() < 0.7,
    });
  }
  return {
    seed,
    workers,
    entrySubset,
    chains,
    loopFrom,
    loopTo,
    loopPasses,
    sendFrom,
    sendTo,
    joins,
  };
};

const buildGraph = (spec: Spec, checkpointer?: MemorySaver) => {
  const mark = (name: string) => () => ({ ran: [name] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let g: any = new StateGraph(State);
  for (const w of spec.workers) g = g.addNode(w, mark(w));
  for (const j of spec.joins) g = g.addNode(j.target, mark(j.target));

  g = g.addConditionalEdges(START, () => spec.entrySubset, spec.workers);
  for (const [from, to] of spec.chains) g = g.addEdge(from, to);

  if (spec.loopFrom && spec.loopTo) {
    const from = spec.loopFrom;
    const to = spec.loopTo;
    const passes = spec.loopPasses;
    g = g.addConditionalEdges(
      from,
      (s: { ran: string[] }) =>
        s.ran.filter((x) => x === from).length < passes ? to : END,
      [to, END]
    );
  }
  if (spec.sendFrom && spec.sendTo) {
    const to = spec.sendTo;
    g = g.addConditionalEdges(spec.sendFrom, () => [new Send(to, {})], [to]);
  }
  for (const j of spec.joins) {
    g = g.addEdge(
      j.sources,
      j.target,
      j.inclusive ? { inclusive: true } : undefined
    );
    g = g.addEdge(j.target, END);
  }
  return g.compile(checkpointer ? { checkpointer } : undefined);
};

const count = (ran: string[], name: string) =>
  ran.filter((x) => x === name).length;

describe("fuzz: inclusive waiting edges across random graph shapes", () => {
  it("300 seeded graphs hold the release invariants", async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const spec = genSpec(seed);
      const graph = buildGraph(spec, new MemorySaver());
      const config = {
        configurable: { thread_id: `fuzz-${seed}` },
        recursionLimit: 60,
      };
      let outcome = "done";
      let ran: string[] = [];
      try {
        const res = (await graph.invoke({}, config)) as { ran: string[] };
        ran = res.ran;
      } catch (e) {
        outcome = (e as Error).name;
      }

      const problems: string[] = [];
      if (outcome === "done") {
        const snapshot = await graph.getState(config);
        const inclusiveTargets = new Set(
          spec.joins.filter((j) => j.inclusive).map((j) => j.target)
        );
        for (const entry of snapshot.waitingEdges ?? []) {
          if (inclusiveTargets.has(entry.target)) {
            problems.push(
              `I1: inclusive edge into ${entry.target} left holding ${JSON.stringify(entry.completed)}`
            );
          }
        }
        const maxRuns = (node: string): number => {
          let runs = spec.entrySubset.includes(node) ? 1 : 0;
          for (const [from, to] of spec.chains) {
            if (to === node) runs += maxRuns(from);
          }
          if (spec.sendTo === node && spec.sendFrom !== undefined) {
            runs += maxRuns(spec.sendFrom);
          }
          return runs;
        };
        for (const j of spec.joins) {
          if (!j.inclusive) continue;
          if (spec.loopFrom !== undefined) continue;
          if (spec.sendTo === j.target) continue;
          const sourceRan = j.sources.some((s) => count(ran, s) > 0);
          const targetRuns = count(ran, j.target);
          const arrivals = j.sources.reduce((sum, s) => sum + maxRuns(s), 0);
          const singleArrival = j.sources.every((s) => maxRuns(s) <= 1);
          const lower = sourceRan ? 1 : 0;
          const upper = sourceRan ? (singleArrival ? 1 : arrivals) : 0;
          if (targetRuns < lower || targetRuns > upper) {
            problems.push(
              `I4: ${j.target} ran ${targetRuns}x, expected ${lower}..${upper}`
            );
          }
        }
      } else if (outcome !== "GraphRecursionError") {
        problems.push(`unexpected outcome: ${outcome}`);
      } else if (spec.loopFrom === undefined && spec.sendFrom === undefined) {
        problems.push(`recursion limit hit on a loop-free, send-free graph`);
      }

      if (problems.length > 0) {
        failures.push(
          `seed=${seed} ${problems.join(" | ")} ran=${JSON.stringify(ran)} spec=${JSON.stringify(spec)}`
        );
      }
    }
    expect(failures).toEqual([]);
  }, 120000);

  it("60 seeded graphs: interrupt + resume produces the uninterrupted result", async () => {
    const failures: string[] = [];
    for (let seed = 301; seed <= 360; seed += 1) {
      const spec = genSpec(seed);

      const plain = buildGraph(spec, new MemorySaver());
      const plainConfig = {
        configurable: { thread_id: `plain-${seed}` },
        recursionLimit: 60,
      };
      let plainOutcome = "done";
      let plainRan: string[] = [];
      try {
        const res = (await plain.invoke({}, plainConfig)) as { ran: string[] };
        plainRan = res.ran;
      } catch (e) {
        plainOutcome = (e as Error).name;
      }
      if (plainOutcome !== "done") continue;

      const graph = buildGraph(spec, new MemorySaver());
      const config = {
        configurable: { thread_id: `resume-${seed}` },
        recursionLimit: 60,
        interruptAfter: [spec.entrySubset[0]],
      };
      let outcome = "done";
      let ran: string[] = [];
      try {
        await graph.invoke({}, config);
        // `next` alone decides whether the run is over — which is what the
        // armed-inclusive-edge augmentation of `next` guarantees
        for (let hop = 0; hop < 20; hop += 1) {
          const snapshot = await graph.getState(config);
          if (snapshot.next.length === 0) break;
          await graph.invoke(null, config);
        }
        const finalSnapshot = await graph.getState(config);
        ran = (finalSnapshot.values as { ran: string[] }).ran;
      } catch (e) {
        outcome = (e as Error).name;
      }

      const sorted = (xs: string[]) => [...xs].sort().join(",");
      if (outcome !== "done" || sorted(ran) !== sorted(plainRan)) {
        failures.push(
          `seed=${seed} outcome=${outcome} plain=${sorted(plainRan)} resumed=${sorted(ran)} spec=${JSON.stringify(spec)}`
        );
      }
    }
    expect(failures).toEqual([]);
  }, 120000);
});
