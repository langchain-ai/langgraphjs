import { BaseMessage } from "@langchain/core/messages";
import { StateGraph } from "./state.js";

type Messages = Array<BaseMessage> | BaseMessage;

export class MessageGraph extends StateGraph<BaseMessage[], Messages> {
  constructor() {
    super({
      channels: {
        __root__: [],
      },
    });
  }
}

export interface MessagesState {
  messages: BaseMessage[];
}
