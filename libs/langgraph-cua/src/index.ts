// CUA Agent here

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

const GraphAnnotation = Annotation.Root({
  /**
   * The message list between the user & assistant. This contains
   * messages, including the computer use calls.
   */
  messages: MessagesAnnotation.spec.messages,
});
