/**
 * Track subagent lifecycle without subscribing to heavy channels.
 *
 * In-process equivalent of the remote `subagent-status` example. The native
 * `run.subagents` projection yields one `SubagentRunStream` per `task` tool
 * call — nothing else. Unlike `run.subgraphs`, it does not surface internal
 * subgraphs such as the coordinator's `model_request` LLM call, so you can
 * count started/completed/failed without filtering.
 *
 * Each `SubagentRunStream` exposes an `output` promise that resolves when
 * the subagent's task finishes, making it easy to maintain a running
 * tally. Heavier projections (`messages`, `values`) are never materialised
 * unless you access them on an individual handle.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/subagent-status/in-process.ts
 */

import { agent } from "../agents/deep-agent.js";

const run = await agent.streamEvents(
  {
    messages: [
      {
        role: "user",
        content:
          "Write four poems: a haiku about mountains, a limerick about cats, a quatrain about rain, and a long poem about space",
      },
    ],
  },
  { version: "v3", configurable: { thread_id: `subagent-status-${Date.now()}` } }
);

const graphStartMs = performance.now();

function elapsedSinceGraphStart(): string {
  const s = (performance.now() - graphStartMs) / 1000;
  return `${s.toFixed(2)}s`;
}

let started = 0;
let completed = 0;
let failed = 0;

function printStatus() {
  const total = started + completed + failed;
  console.log(
    `  [${total} subagent(s)] ` +
    `started: ${started}, ` +
    `completed: ${completed}, ` +
    `failed: ${failed}`
  );
}

const watchers: Promise<void>[] = [];

for await (const sub of run.subagents) {
  started += 1;
  console.log(`[${elapsedSinceGraphStart()}] ${sub.name}: started`);
  printStatus();

  watchers.push(
    sub.output.then(
      () => {
        started -= 1;
        completed += 1;
        console.log(`[${elapsedSinceGraphStart()}] ${sub.name}: completed`);
        printStatus();
      },
      () => {
        started -= 1;
        failed += 1;
        console.log(`[${elapsedSinceGraphStart()}] ${sub.name}: failed`);
        printStatus();
      }
    )
  );
}

await Promise.all(watchers);

console.log("\n=== Final ===");
console.log(
  `  [${elapsedSinceGraphStart()}] started: ${started}, completed: ${completed}, failed: ${failed}`
);
console.log("\nDone.");
