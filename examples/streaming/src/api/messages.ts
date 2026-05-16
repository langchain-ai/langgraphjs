/**
 * Token-level message streaming via the Python langgraph-api server.
 *
 * Drives `agent_echo_stream` and consumes the `messages` projection on
 * the thread stream. Each streamed message exposes its text as both an
 * `AsyncIterable<string>` (for delta-by-delta rendering) and a
 * `PromiseLike<string>` (for the finalized text), matching the
 * in-process `run.messages` shape.
 *
 * What this proves is working on the Python server:
 *   - `message-start` → `content-block-start/delta/finish` →
 *     `message-finish` lifecycle is produced for every AI message
 *   - `node` field (if provided by the graph) lands in `params.node`
 *   - Finish reason is preserved; `usage` is preserved *when the model
 *     reports it* — `FakeListChatModel` (used by `agent_echo_stream`)
 *     does not, so `message.usage` resolves to `undefined` here. Swap
 *     in a real provider to see the field populated end-to-end.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/messages.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, requireServer } from "./_shared.js";

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream({ assistantId: "agent_echo_stream" });

  await thread.run.start({
    input: {
      messages: [
        {
          role: "user",
          content:
            "Tell me about content-block streaming over Protocol v2.",
        },
      ],
    },
  });

  console.log("--- Streaming messages ---\n");

  let index = 0;
  for await (const message of thread.messages) {
    index += 1;
    const node = message.node ?? "(unknown)";
    process.stdout.write(`[#${index} from "${node}"] `);

    for await (const delta of message.text) {
      process.stdout.write(delta);
    }

    const usage = await message.usage;
    if (usage) {
      process.stdout.write(
        `\n  (tokens: ${usage.input_tokens ?? 0} in, ${usage.output_tokens ?? 0} out)`
      );
    } else {
      // `agent_echo_stream` uses `FakeListChatModel`, which doesn't set
      // `usage_metadata` on its chunks — the server's `message-finish`
      // therefore omits the optional `usage` field and the SDK resolves
      // `message.usage` to `undefined`. Real providers (OpenAI, Anthropic,
      // etc.) populate this on the terminal chunk.
      process.stdout.write("\n  (no usage reported by this model)");
    }
    process.stdout.write("\n\n");
  }

  const finalState = (await thread.output) as
    | { messages?: { content?: unknown }[] }
    | undefined;
  console.log(
    `--- Final state: ${finalState?.messages?.length ?? 0} message(s) ---`
  );

  await thread.close();
}

await main();
