/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "./annotation.js";
import { messagesStateReducer } from "./message.js";

export const MessagesState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});