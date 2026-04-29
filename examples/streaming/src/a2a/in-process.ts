/**
 * A2A streaming in-process using `streamEvents(..., { version: "v3" })`.
 *
 * The research pipeline is compiled with `createA2ATransformer` (see
 * `agents/a2a-research.ts`) which exposes a `StreamChannel` projection
 * named `a2a`. In-process, this channel is available as
 * `run.extensions.a2a` and yields A2A protocol-compliant
 * `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` values.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/a2a/in-process.ts
 */

import { graph } from "../agents/a2a-research.js";

const run = await graph.streamEvents(
  {
    messages: [
      {
        role: "user",
        content: "Research WebAssembly adoption and identify key risks.",
      },
    ],
  },
  { version: "v3" }
);

console.log("--- Streaming A2A events (in-process) ---\n");

for await (const event of run.extensions.a2a) {
  console.log(JSON.stringify(event));
}

await run.output;
console.log("\n--- Done ---");
