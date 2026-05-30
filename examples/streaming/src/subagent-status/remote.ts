/**
 * Track how many subagents are running vs completed without subscribing to
 * all channels (remote variant using the SDK client).
 *
 * `thread.subagents` only subscribes to the `tools` + `lifecycle` channels.
 * Each yielded `SubagentHandle` has an `output` promise that resolves when
 * the task tool finishes, making it easy to track started/completed counts.
 * Heavier channels (`messages`, `values`) are never subscribed unless you
 * access the corresponding getter on an individual `SubagentHandle`.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/subagent-status/remote.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { startDevServer } from "../shared/dev-server.js";

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer({ silent: true });

  try {
    const client = new Client({ apiUrl: url });

    const thread = client.threads.stream({ assistantId: "deep-agent" });

    await thread.run.start({
      input: {
        messages: [
          {
            role: "user",
            content:
              "Write four poems: a haiku about mountains, a limerick about cats, a quatrain about rain, and a long poem about space",
          },
        ],
      },
    });

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

    for await (const subagent of thread.subagents) {
      started += 1;
      console.log(
        `[${elapsedSinceGraphStart()}] ${subagent.name}: started (${subagent.callId})`
      );
      printStatus();

      subagent.output.then(
        () => {
          started -= 1;
          completed += 1;
          console.log(
            `[${elapsedSinceGraphStart()}] ${subagent.name}: completed (${subagent.callId})`
          );
          printStatus();
        },
        () => {
          started -= 1;
          failed += 1;
          console.log(
            `[${elapsedSinceGraphStart()}] ${subagent.name}: failed (${subagent.callId})`
          );
          printStatus();
        }
      );
    }

    console.log("\n=== Final ===");
    console.log(
      `  [${elapsedSinceGraphStart()}] started: ${started}, completed: ${completed}, failed: ${failed}`
    );

    await thread.close();
    console.log("\nDone.");
  } finally {
    stop();
  }
}

await main();
