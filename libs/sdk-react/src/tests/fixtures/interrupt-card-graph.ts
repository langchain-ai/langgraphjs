import { interrupt } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createAgent, tool } from "langchain";
import { z } from "zod/v4";

import { createDeterministicToolCallingModel } from "./shared.js";

/**
 * Mirrors a customer HITL pattern where the interrupt is raised *from
 * within a tool*:
 *
 *  1. The tool builds a JSON "card" the frontend renders validation
 *     buttons from, and attaches it to an `AIMessage`
 *     (`response_metadata.cards`).
 *  2. It `interrupt()`s with that message and waits for the human.
 *  3. The tool's real business logic is slow, so the frontend pushes the
 *     card into state *alongside* the resume
 *     (`respond(decision, { update: { messages: [card] } })`) — the
 *     backend never adds the card itself. This keeps the card visible
 *     (no flicker / disappearance) while the tool executes.
 *  4. On reject the tool short-circuits with a tool result; on approve it
 *     runs the slow logic and returns the result — never the card, which
 *     the frontend already committed.
 */

/**
 * Simulated duration of the tool's "real" business logic. Long enough
 * that the test can observe the FE-pushed card sitting in state while the
 * run is still in flight (the no-flicker guarantee).
 */
export const TOOL_BUSINESS_LOGIC_DELAY_MS = 1000;

const reviewActionTool = tool(
  async ({ toolArg }: { toolArg: string }) => {
    // 1. The card the frontend renders validation buttons from.
    const card = {
      kind: "tool_validation",
      action: toolArg,
      buttons: ["approve", "reject"],
    };

    // 2. Interrupt carrying the AIMessage (the card lives in
    //    `response_metadata.cards`). `interrupt()`'s value must be
    //    JSON-serializable, so the message is surfaced as a plain dict;
    //    the frontend rebuilds an `AIMessage` from it before pushing to
    //    state.
    const response = interrupt({
      type: "ai",
      content: `Please review the "${toolArg}" action.`,
      response_metadata: { cards: card },
    });

    // 3. We only reach here once the human responded — and, in this flow,
    //    once the frontend has already pushed the card into state.
    const approved =
      response === true ||
      (response != null &&
        typeof response === "object" &&
        (response as { approved?: unknown }).approved === true);

    if (!approved) {
      // User rejected: inform the agent, skip the business logic. The
      // backend does not add the card — the frontend already did.
      return "User has rejected the toolcall";
    }

    // 4. Long-running business logic. The card must stay in state (placed
    //    by the frontend) for the entire duration — it must not flicker
    //    away.
    await new Promise((resolve) =>
      setTimeout(resolve, TOOL_BUSINESS_LOGIC_DELAY_MS)
    );

    // The backend returns only the tool result — NOT the card.
    return `Executed "${toolArg}".`;
  },
  {
    name: "review_action",
    description: "Perform a sensitive action that requires human approval.",
    schema: z.object({ toolArg: z.string() }),
  }
);

export const graph = createAgent({
  model: createDeterministicToolCallingModel({
    toolCallId: "call-review-1",
    toolName: "review_action",
    toolArgs: { toolArg: "delete_db" },
    finalText: "Done.",
  }),
  tools: [reviewActionTool],
  systemPrompt: "You are a deterministic approval agent for protocol testing.",
  checkpointer: new MemorySaver(),
});
