import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod/v4";

import { ReducedValue } from "../values/reduced.js";
import {
  messagesStateReducer,
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
