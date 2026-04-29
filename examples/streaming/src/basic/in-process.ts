/**
 * Basic streamEvents(..., { version: "v3" }) usage — iterate protocol events and await final output.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/basic/in-process.ts
 */

import { graph } from "../agents/simple-tool-graph.js";

const run = await graph.streamEvents(
  {
    messages: [{ role: "user", content: "What is 42 * 17?" }],
  },
  { version: "v3" }
);

console.log("--- Streaming All protocol events (in-process) ---\n");

for await (const event of run) {
  const ns = event.params.namespace;
  const prefix = ns.length > 0 ? `[${ns.join("/")}] ` : "";
  console.log(
    `${prefix}${event.method}`,
    JSON.stringify(event.params.data).slice(0, 120)
  );
}

const finalState = await run.output;
const lastMsg = finalState?.messages?.at(-1);
console.log("\n--- Final answer ---");
console.log(
  typeof lastMsg?.content === "string"
    ? lastMsg.content
    : JSON.stringify(lastMsg?.content)
);
