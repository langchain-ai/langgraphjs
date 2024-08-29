/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "./annotation.js";
import { messagesStateReducer } from "./message.js";

/**
 * Prebuilt state annotation that combines returned messages.
 * Can handle standard messages and special modifiers like {@link RemoveMessage}
 * instances.
 */
export const MessagesAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});
