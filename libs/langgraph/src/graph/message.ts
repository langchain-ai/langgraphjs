import {
  BaseMessage,
  BaseMessageLike,
  coerceMessageLikeToMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { v4 } from "uuid";
import { StateGraph } from "./state.js";
import type { StreamMessagesHandler } from "../pregel/messages.js";

export const REMOVE_ALL_MESSAGES = "__remove_all__";

export type Messages =
  | Array<BaseMessage | BaseMessageLike>
  | BaseMessage
  | BaseMessageLike;

/**
 * Prebuilt reducer that combines returned messages.
 * Can handle standard messages and special modifiers like {@link RemoveMessage}
 * instances.
 */
export function messagesStateReducer(
  left: Messages,
  right: Messages
): BaseMessage[] {
  const leftArray = Array.isArray(left) ? left : [left];
  const rightArray = Array.isArray(right) ? right : [right];
  // coerce to message
  const leftMessages = (leftArray as BaseMessageLike[]).map(
    coerceMessageLikeToMessage
  );
  const rightMessages = (rightArray as BaseMessageLike[]).map(
    coerceMessageLikeToMessage
  );
  // assign missing ids
  for (const m of leftMessages) {
    if (m.id === null || m.id === undefined) {
      m.id = v4();
      m.lc_kwargs.id = m.id;
    }
  }

  let removeAllIdx: number | undefined;
  for (let i = 0; i < rightMessages.length; i += 1) {
    const m = rightMessages[i];
    if (m.id === null || m.id === undefined) {
      m.id = v4();
      m.lc_kwargs.id = m.id;
    }

    if (m.getType() === "remove" && m.id === REMOVE_ALL_MESSAGES) {
      removeAllIdx = i;
    }
  }

  if (removeAllIdx != null) return rightMessages.slice(removeAllIdx + 1);

  // merge
  const merged = [...leftMessages];
  const mergedById = new Map(merged.map((m, i) => [m.id, i]));
  const idsToRemove = new Set();
  for (const m of rightMessages) {
    const existingIdx = mergedById.get(m.id);
    if (existingIdx !== undefined) {
      if (m.getType() === "remove") {
        idsToRemove.add(m.id);
      } else {
        idsToRemove.delete(m.id);
        merged[existingIdx] = m;
      }
    } else {
      if (m.getType() === "remove") {
        throw new Error(
          `Attempting to delete a message with an ID that doesn't exist ('${m.id}')`
        );
      }
      mergedById.set(m.id, merged.length);
      merged.push(m);
    }
  }
  return merged.filter((m) => !idsToRemove.has(m.id));
}

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
  const rawOptions:
    | (RunnableConfig & { stateKey?: string | null })
    | undefined =
    options ?? AsyncLocalStorageProviderSingleton.getRunnableConfig();

  if (rawOptions == null) {
    throw new Error("Calling pushMessage outside the context of a graph.");
  }

  const { stateKey: userStateKey, ...config } = rawOptions;
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
