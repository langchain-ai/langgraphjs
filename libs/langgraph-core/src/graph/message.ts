import {
  BaseMessage,
  BaseMessageLike,
  coerceMessageLikeToMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { StateGraph } from "./state.js";
import { ensureLangGraphConfig } from "../pregel/utils/config.js";
import type { StreamMessagesHandler } from "../pregel/messages.js";
import { messagesStateReducer, type Messages } from "./messages_reducer.js";

/** @ignore */
export class MessageGraph extends StateGraph<
  BaseMessage[],
  BaseMessage[],
  Messages
> {
  constructor() {
    super({
      channels: {
        __root__: {
          reducer: messagesStateReducer,
          default: () => [],
        },
      },
    });
  }
}

/**
 * Manually push a message to a message stream.
 *
 * This is useful when you need to push a manually created message before the node
 * has finished executing.
 *
 * When a message is pushed, it will be automatically persisted to the state after the node has finished executing.
 * To disable persisting, set `options.stateKey` to `null`.
 *
 * @param message The message to push. The message must have an ID set, otherwise an error will be thrown.
 * @param options RunnableConfig / Runtime coming from node context.
 */
export function pushMessage(
  message: BaseMessage | BaseMessageLike,
  options?: RunnableConfig & {
    /**
     * The key of the state to push the message to. Set to `null` to avoid persisting.
     * @default "messages"
     */
    stateKey?: string | null;
  }
) {
  const { stateKey: userStateKey, ...userConfig } = options ?? {};
  const config = ensureLangGraphConfig(userConfig);

  let stateKey: string | undefined = userStateKey ?? "messages";
  if (userStateKey === null) stateKey = undefined;

  // coerce to message
  const validMessage = coerceMessageLikeToMessage(message);
  if (!validMessage.id) throw new Error("Message ID is required.");

  const callbacks = (() => {
    if (Array.isArray(config.callbacks)) {
      return config.callbacks;
    }

    if (typeof config.callbacks !== "undefined") {
      return config.callbacks.handlers;
    }

    return [];
  })();

  const messagesHandler = callbacks.find(
    (cb): cb is StreamMessagesHandler =>
      "name" in cb && cb.name === "StreamMessagesHandler"
  );

  if (messagesHandler) {
    const metadata = config.metadata ?? {};
    const namespace = (
      (metadata.langgraph_checkpoint_ns ?? "") as string
    ).split("|");

    messagesHandler._emit(
      [namespace, metadata],
      validMessage,
      undefined,
      false
    );
  }

  if (stateKey) {
    config.configurable?.__pregel_send?.([[stateKey, validMessage]]);
  }

  return validMessage;
}
