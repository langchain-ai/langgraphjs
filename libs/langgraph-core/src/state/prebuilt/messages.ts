import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod/v4";

import { ReducedValue } from "../values/reduced.js";
import { DeltaValue } from "../values/delta.js";
import {
  messagesStateReducer,
  messagesDeltaReducer,
  type Messages,
} from "../../graph/messages_reducer.js";

const messagesValueSchema = z.custom<BaseMessage[]>().default(() => []);
const messagesInputSchema = z.custom<Messages>();

export const MessagesValue = new ReducedValue(
  // Value schema: array of BaseMessage
  messagesValueSchema,
  {
    // Input schema: accepts flexible message types
    inputSchema: messagesInputSchema,
    // Use the existing messagesStateReducer
    reducer: messagesStateReducer,
    // JSON schema extras for Studio
    jsonSchemaExtra: {
      langgraph_type: "messages",
      description: "A list of chat messages",
    },
  }
);

/**
 * **Experimental.** A messages state field backed by a `DeltaChannel`.
 *
 * A drop-in alternative to {@link MessagesValue} that persists only per-step
 * message deltas (plus periodic snapshots) instead of the full accumulated
 * history in every checkpoint blob. Useful for long-running threads where
 * re-serializing the entire message list on each step is costly.
 *
 * @example
 * ```ts
 * import { StateSchema, MessagesDeltaValue } from "@langchain/langgraph";
 *
 * const State = new StateSchema({ messages: MessagesDeltaValue });
 * ```
 */
export const MessagesDeltaValue = new DeltaValue(messagesValueSchema, {
  inputSchema: messagesInputSchema,
  reducer: messagesDeltaReducer,
  jsonSchemaExtra: {
    langgraph_type: "messages",
    description: "A list of chat messages",
  },
});
