import { MemorySaver } from "@langchain/langgraph";
import { createQuickJSMiddleware } from "@langchain/quickjs";
import { createDeepAgent, StoreBackend } from "deepagents";
import { tool } from "langchain";
import { z } from "zod/v4";

import { modelName } from "./shared";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Each worker runs this tool a couple of times (the subagent prompt below
// enforces ≥ 2 calls per worker). That fills the `tools` channel with enough
// chatter that lazy per-subagent subscriptions are visibly different from an
// eager subscribe-everywhere design.
const factCard = tool(
  async ({
    worker,
    topic,
    attempt,
  }: {
    worker: string;
    topic: string;
    attempt: number;
  }) => {
    await sleep(80 + (attempt % 3) * 40);
    return JSON.stringify({
      worker,
      topic,
      attempt,
      fact: `${worker} finished step ${attempt + 1} of "${topic}".`,
    });
  },
  {
    name: "fact_card",
    description:
      "Record a compact fact card for the assigned worker. Call this at least twice so the per-subagent tool stream has enough traffic to be interesting.",
    schema: z.object({
      worker: z.string().describe("Worker identifier, e.g. worker-017."),
      topic: z.string().describe("Topic assigned to this worker."),
      attempt: z
        .number()
        .int()
        .nonnegative()
        .describe("Zero-based attempt number."),
    }),
  }
);

const checkpointer = new MemorySaver();

export async function agent() {
  const backend = new StoreBackend({ fileFormat: "v2" });
  return createDeepAgent({
    model: modelName,
    backend,
    checkpointer,
    middleware: [
      createQuickJSMiddleware({
        backend,
        ptc: ["task"],
      }),
    ],
    subagents: [
      {
        name: "fanout-worker",
        description:
          "Short-lived subagent. Emits a couple of fact_card tool calls about the assigned topic.",
        systemPrompt: `You are a fanout worker.

Rules:
- You are assigned exactly one topic and one worker id.
- Call fact_card 2-3 times with increasing "attempt" values (0, 1, 2).
- Return a single sentence summarizing your work. No JSON, no bullets.
- Do not call any other tools.`,
        tools: [factCard],
      },
    ],
    systemPrompt: `You are the fan-out benchmark coordinator.

Your only job is to kick off a large parallel subagent run so the UI can
demonstrate that 100+ concurrent subagents stay fast when only the open
subagent cards actually open a message subscription.

Call js_eval exactly once with a script shaped like this:

\`\`\`js
const N = <count>;
const topics = ["history", "ecology", "culture", "industry", "folklore", "geography"];
const tasks = [];
for (let i = 0; i < N; i++) {
  tasks.push(tools.task({
    subagentType: "fanout-worker",
    description: \`Worker worker-\${String(i).padStart(3, "0")} covering \${topics[i % topics.length]} around the user's topic.\`,
  }));
}
const results = await Promise.all(tasks);
return { launched: N, sample: results.slice(0, 3) };
\`\`\`

Rules:
- Default N to 100 if the user does not specify a count. Otherwise use the
  explicit number they ask for (clamp to 1..200).
- Do everything inside a single js_eval call, not multiple.
- Always launch the workers with Promise.all, not sequentially.
- Every task must use subagentType: "fanout-worker".
- After js_eval returns, write a single short sentence reporting how many
  workers were launched.`,
  });
}
