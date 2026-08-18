import { AIMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";

/**
 * Deterministic graph that raises a *custom* interrupt payload — the shape a
 * product surface defines itself, rather than the `humanInTheLoopMiddleware`
 * action-request envelope. No model is involved, so the interrupt → respond →
 * follow-up → reload lifecycle reproduces byte-for-byte on every run and
 * without provider credentials.
 */

export interface ApprovalInterrupt {
  type: "approval";
  question: string;
  requestedBy: string;
}

export interface ApprovalResponse {
  approved: boolean;
  note?: string;
}

/** Human turns containing this word pause the run on a custom interrupt. */
export const INTERRUPT_TRIGGER = "approval";
/**
 * Human turns containing this word stay in flight long enough to reload the
 * page mid-run, which is what forces hydration to race the event replay.
 */
export const SLOW_TRIGGER = "slowly";

const SLOW_TURN_MS = 20_000;

export const agent = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => {
    const prompt = state.messages.at(-1)?.text ?? "";

    if (!prompt.toLowerCase().includes(INTERRUPT_TRIGGER)) {
      if (prompt.toLowerCase().includes(SLOW_TRIGGER)) {
        await new Promise((resolve) => setTimeout(resolve, SLOW_TURN_MS));
      }
      return { messages: [new AIMessage(`Echo: ${prompt}`)] };
    }

    const decision = interrupt<ApprovalInterrupt, ApprovalResponse>({
      type: "approval",
      question: `Approve this request? "${prompt}"`,
      requestedBy: "custom-interrupt-demo",
    });

    const verdict = decision.approved ? "Approved" : "Rejected";
    const note = decision.note ? ` (${decision.note})` : "";
    return { messages: [new AIMessage(`${verdict} the request.${note}`)] };
  })
  .addEdge(START, "agent")
  .addEdge("agent", END)
  .compile();
