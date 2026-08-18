/**
 * Deterministic custom-interrupt graph used by the reload reconciliation
 * example. It does not call a model, so the full lifecycle can be verified
 * without provider credentials.
 */

import { AIMessage } from "@langchain/core/messages";
import {
  MessagesAnnotation,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";

export interface ApprovalInterrupt {
  type: "approval";
  question: string;
}

export interface ApprovalResponse {
  approved: boolean;
}

const INTERRUPT_PROMPT = "Please request approval";

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", (state) => {
    const lastMessage = state.messages.at(-1);
    const content =
      typeof lastMessage?.content === "string" ? lastMessage.content : "";

    if (content === INTERRUPT_PROMPT) {
      const response = interrupt<ApprovalInterrupt, ApprovalResponse>({
        type: "approval",
        question: "Approve this request?",
      });
      return {
        messages: [
          new AIMessage(
            response.approved ? "Request approved." : "Request rejected."
          ),
        ],
      };
    }

    return {
      messages: [new AIMessage(`Echo: ${content}`)],
    };
  })
  .addEdge(START, "agent")
  .compile();

export { INTERRUPT_PROMPT };
