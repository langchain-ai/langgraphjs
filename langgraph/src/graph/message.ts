import { BaseMessage } from "@langchain/core/messages";
import { StateGraph } from "./state.js";

type Messages = Array<BaseMessage> | BaseMessage;

function addMessages<T extends Messages>(left: T, right: T) {
  const leftArray = Array.isArray(left) ? left : [left];
  const rightArray = Array.isArray(right) ? right : [right];
  return [...leftArray, ...rightArray];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class MessageGraph<T extends Messages> extends StateGraph<T> {
  constructor() {
    super({
      channels: {
        value: (a: T, b: T) => addMessages<T>(a, b),
        default: () => [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
  }
}
