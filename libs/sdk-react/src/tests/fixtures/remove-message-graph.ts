/* eslint-disable import/no-extraneous-dependencies */
import { randomUUID } from "node:crypto";
import {
  AIMessage,
  RemoveMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  MessagesAnnotation,
  pushMessage,
  START,
  StateGraph,
} from "@langchain/langgraph";

/**
 * Exercises `RemoveMessage` semantics: step1 adds an AIMessage, step2
 * removes every AIMessage and appends a fresh one, step3 appends a
 * final AIMessage. The client should see the removed messages drop
 * out of the projected `messages` array and the new ones appear.
 */
const graph = new StateGraph(MessagesAnnotation)
  .addSequence({
    step1: () => ({ messages: [new AIMessage("Step 1: To Remove")] }),
    step2: async (state) => {
      const messages: BaseMessage[] = [
        ...state.messages
          .filter((m) => AIMessage.isInstance(m))
          .map((m) => new RemoveMessage({ id: m.id! })),
        new AIMessage({ id: randomUUID(), content: "Step 2: To Keep" }),
      ];

      for (const message of messages) {
        pushMessage(message, { stateKey: null });
      }

      return { messages };
    },
    step3: () => ({ messages: [new AIMessage("Step 3: To Keep")] }),
  })
  .addEdge(START, "step1")
  .compile();

export { graph };
