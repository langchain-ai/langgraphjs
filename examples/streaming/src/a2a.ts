/**
 * A2A streaming over a deployed LangGraph server using the v2 protocol.
 *
 * The research pipeline is compiled with `createA2AReducer` which emits
 * A2A protocol-compliant `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent`
 * events (from `@a2a-js/sdk`) on the `"custom:a2a"` channel.
 *
 * Subscribing to `"custom:a2a"` only delivers custom events whose `name`
 * is `"a2a"`, filtering out unrelated custom events automatically.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/a2a.ts
 */

import { Client } from "@langchain/langgraph-sdk";
import { startDevServer } from "./a2a/server.js";

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer();

  try {
    const client = new Client({ apiUrl: url });

    const session = await client.stream.open({
      protocol_version: "0.3.0",
      target: { id: "a2a-research" },
    });

    // Subscribe only to A2A custom events via the "custom:a2a" channel
    const events = await session.subscribe("custom:a2a");

    await session.run.input({
      input: {
        messages: [
          {
            role: "user",
            content: "Research WebAssembly adoption and identify key risks.",
          },
        ],
      },
    });

    console.log("--- Streaming A2A events ---\n");

    for await (const event of events) {
      console.log(JSON.stringify(event));
    }

    await session.close();
    console.log("--- Done ---");
  } finally {
    stop();
  }
}

await main();
