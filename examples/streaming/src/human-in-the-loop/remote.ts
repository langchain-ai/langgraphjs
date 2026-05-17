/**
 * Human-in-the-loop (remote) — detect an interrupt, inspect the payload,
 * and resume via `thread.input.respond(...)`.
 *
 * Uses the same `humanInTheLoopMiddleware`-backed agent as the in-process
 * variant. A single `values` subscription on the `ThreadStream` survives
 * across the interrupt and resumed run without re-subscribing.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/human-in-the-loop/remote.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { startDevServer } from "../shared/dev-server.js";

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer({ silent: true });

  try {
    const client = new Client({ apiUrl: url });

    const thread = client.threads.stream({
      assistantId: "human-in-the-loop",
    });

    await thread.run.start({
      input: {
        messages: [
          {
            role: "user",
            content:
              "Send a release update email about the new streaming API",
          },
        ],
      },
    });

    for await (const snapshot of thread.values) {
      const state = snapshot as Record<string, unknown>;
      const msgCount = (state.messages as unknown[])?.length ?? 0;
      console.log(`  State snapshot: ${msgCount} message(s)`);

      if (thread.interrupted) break;
    }

    if (thread.interrupted) {
      console.log(
        `\nRun interrupted with ${thread.interrupts.length} interrupt(s):\n`
      );

      for (const interrupt of thread.interrupts) {
        console.log(`  Interrupt ID: ${interrupt.interruptId}`);
        console.log(
          `  Namespace:    ${interrupt.namespace.join("/") || "(root)"}`
        );
        console.log(
          `  Payload:      ${JSON.stringify(interrupt.payload, null, 2)}`
        );
      }

      console.log("\nApproving all pending actions...");

      for (const interrupt of thread.interrupts) {
        const payload = interrupt.payload as {
          actionRequests?: Array<{ name: string }>;
        };
        const decisions = (payload.actionRequests ?? []).map((req) => ({
          action: req.name,
          type: "approve" as const,
        }));

        await thread.input.respond({
          namespace: interrupt.namespace,
          interrupt_id: interrupt.interruptId,
          response: { decisions },
        });
      }

      console.log("Resumed. Waiting for final state...\n");

      for await (const snapshot of values) {
        const state = snapshot as Record<string, unknown>;
        const msgCount = (state.messages as unknown[])?.length ?? 0;
        console.log(`  State snapshot: ${msgCount} message(s)`);
      }

      const finalState = await thread.output;
      const messages = (finalState as { messages: unknown[] })?.messages ?? [];
      console.log(`\nFinal state: ${messages.length} messages`);
    } else {
      console.log("\nRun completed without interrupts.");
      const finalState = await thread.output;
      console.log(`Final state: ${JSON.stringify(finalState).slice(0, 200)}`);
    }

    await thread.close();
    console.log("Done.");
  } finally {
    stop();
  }
}

await main();
