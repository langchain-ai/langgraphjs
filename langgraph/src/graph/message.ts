import { BaseMessage } from "@langchain/core/messages";
import { StateGraph } from "./state.js";

type Messages = Array<BaseMessage> | BaseMessage;

function addMessages(left: Messages, right: Messages): Array<BaseMessage> {
  const leftArray = Array.isArray(left) ? left : [left];
  const rightArray = Array.isArray(right) ? right : [right];
  return [...leftArray, ...rightArray];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class MessageGraph<T extends Messages> extends StateGraph<{ messages: T }> {
  constructor() {
    super({
      channels: {
        value: addMessages,
        default: () => [],
      }
    });
  }
}