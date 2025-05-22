import {
  BaseMessage,
  BaseMessageLike,
  coerceMessageLikeToMessage,
} from "@langchain/core/messages";
import { v4 } from "uuid";
import { StateGraph } from "./state.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import type { StreamMessagesHandler } from "../pregel/messages.js";

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
  for (const m of rightMessages) {
    if (m.id === null || m.id === undefined) {
      m.id = v4();
      m.lc_kwargs.id = m.id;
    }
  }
  // merge
  const merged = [...leftMessages];
  const mergedById = new Map(merged.map((m, i) => [m.id, i]));
  const idsToRemove = new Set();
  for (const m of rightMessages) {
    const existingIdx = mergedById.get(m.id);
    if (existingIdx !== undefined) {
      if (m._getType() === "remove") {
        idsToRemove.add(m.id);
      } else {
        idsToRemove.delete(m.id);
        merged[existingIdx] = m;
      }
    } else {
      if (m._getType() === "remove") {
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

export function pushMessage(
  message: BaseMessage | BaseMessageLike,
  config: LangGraphRunnableConfig,
  options?: { stateKey?: string | null }
) {
  let stateKey: string | undefined = options?.stateKey ?? "messages";
  if (options?.stateKey === null) {
    stateKey = undefined;
  }

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
