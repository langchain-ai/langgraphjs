/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "./annotation.js";
import { Messages, messagesStateReducer } from "./message.js";

/**
 * Prebuilt state annotation that combines returned messages.
 * Can handle standard messages and special modifiers like {@link RemoveMessage}
 * instances.
 *
 * Specifically, importing and using the prebuilt MessagesAnnotation like this:
 *
 * @example
 * ```ts
 * import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
 *
 * const graph = new StateGraph(MessagesAnnotation)
 *   .addNode(...)
 *   ...
 * ```
 *
 * Is equivalent to initializing your state manually like this:
 *
 * @example
 * ```ts
 * import { BaseMessage } from "@langchain/core/messages";
 * import { Annotation, StateGraph, messagesStateReducer } from "@langchain/langgraph";
 *
 * export const StateAnnotation = Annotation.Root({
 *   messages: Annotation<BaseMessage[]>({
 *     reducer: messagesStateReducer,
 *     default: () => [],
 *   }),
 * });
 *
 * const graph = new StateGraph(StateAnnotation)
 *   .addNode(...)
 *   ...
 * ```
 */
export const MessagesAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});
