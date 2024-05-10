import { BaseMessage } from "@langchain/core/messages";
import { StateGraph } from "./state.js";

type Messages = Array<BaseMessage> | BaseMessage;

function addMessages(left: Messages, right: Messages): BaseMessage[] {
  const leftArray = Array.isArray(left) ? left : [left];
  const rightArray = Array.isArray(right) ? right : [right];
  return [...leftArray, ...rightArray];
}

export class MessageGraph extends StateGraph<BaseMessage[], Messages> {
  constructor() {
    super({
      channels: {
        __root__: {
          reducer: addMessages,
          default: () => [],
        },
      },
    });
  }
}
