import {
  BaseMessage,
  BaseMessageLike,
  coerceMessageLikeToMessage,
} from "@langchain/core/messages";
import { v4 } from "uuid";
import { StateGraph } from "./state.js";
import { Annotation } from "./annotation.js";

type Messages =
  | Array<BaseMessage | BaseMessageLike>
  | BaseMessage
  | BaseMessageLike;

export function messagesStateReducer(
  left: BaseMessage[],
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
    }
  }
  for (const m of rightMessages) {
    if (m.id === null || m.id === undefined) {
      m.id = v4();
    }
  }
  // merge
  const leftIdxById = new Map(leftMessages.map((m, i) => [m.id, i]));
  const merged = [...leftMessages];
  const idsToRemove = new Set();
  for (const m of rightMessages) {
    const existingIdx = leftIdxById.get(m.id);
    if (existingIdx !== undefined) {
      if (m._getType() === "remove") {
        idsToRemove.add(m.id);
      } else {
        merged[existingIdx] = m;
      }
    } else {
      if (m._getType() === "remove") {
        throw new Error(
          `Attempting to delete a message with an ID that doesn't exist ('${m.id}')`
        );
      }
      merged.push(m);
    }
  }
  return merged.filter((m) => !idsToRemove.has(m.id));
}

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

export const createMessagesState = () => Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

export type MessagesState = ReturnType<typeof createMessagesState>['State'];
