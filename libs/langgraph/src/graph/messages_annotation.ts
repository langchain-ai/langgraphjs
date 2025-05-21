/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

import { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import { z } from "zod";
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

/**
 * Prebuilt state object that uses Zod to combine returned messages.
 * This utility is synonymous with the `MessagesAnnotation` annotation,
 * but uses Zod as the way to express messages state.
 *
 * You can use import and use this prebuilt schema like this:
 *
 * @example
 * ```ts
 * import { MessagesZodState, StateGraph } from "@langchain/langgraph";
 *
 * const graph = new StateGraph(MessagesZodState)
 *   .addNode(...)
 *   ...
 * ```
 *
 * Which is equivalent to initializing the schema object manually like this:
 *
 * @example
 * ```ts
 * import { BaseMessage } from "@langchain/core/messages";
 * import { Annotation, StateGraph, messagesStateReducer } from "@langchain/langgraph";
 *
 * const schema = z.object({
 *   messages: z
 *     .array(z.string())
 *     .default(() => [])
 *     .langgraph.reducer(
 *        messagesStateReducer,
 *        z.union([z.string(), z.array(z.string())])
 *     ),
 * });
 * export const StateAnnotation = Annotation.Root({
 *   messages: Annotation<BaseMessage[]>({
 *     reducer: messagesStateReducer,
 *     default: () => [],
 *   }),
 * });
 *
 * You can also expand this schema to include other fields and retain the core messages field using native zod methods like `z.intersection()` or `.and()`
 * @example
 * ```ts
 * import { MessagesZodState, StateGraph } from "@langchain/langgraph";
 *
 * const schema = MessagesZodState.and(
 *   z.object({ count: z.number() }),
 * );
 *
 * const graph = new StateGraph(schema)
 *  .addNode(...)
 *  ...
 * ```
 */
export const MessagesZodState = z.object({
  // TODO: add validations for BaseMessageLike
  messages: z
    .custom<BaseMessageLike | BaseMessageLike[]>()
    .default(() => [])
    .langgraph.reducer(
      messagesStateReducer,
      z.union([
        z.custom<BaseMessageLike>(),
        z.array(z.custom<BaseMessageLike>()),
      ])
    ),
});
