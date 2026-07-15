import { expect } from "vitest";

/** JSON Schema $ref for message array items inferred from MessagesAnnotation. */
export const BASE_MESSAGE_REF =
  "#/definitions/BaseMessage<MessageStructure<MessageToolSet>,MessageType>";

/**
 * Expected BaseMessage definition shape from @langchain/core >= 1.2.1, where
 * RemoveMessage extends plain BaseMessage and the static schema generator emits
 * a oneOf union for the abstract class.
 */
export const baseMessageDefinitions = {
  "BaseMessage<MessageStructure<MessageToolSet>,MessageType>": {
    description: expect.stringContaining(
      "Base class for all types of messages",
    ),
    oneOf: [{ $ref: "#/definitions/RemoveMessage" }],
  },
};
