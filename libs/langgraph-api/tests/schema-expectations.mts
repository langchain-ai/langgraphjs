import { expect } from "vitest";

/** JSON Schema $ref for message array items inferred from MessagesAnnotation. */
export const BASE_MESSAGE_REF = "#/definitions/BaseMessage";

/**
 * Expected BaseMessage definition shape: a oneOf union of every concrete
 * subclass, keyed by bare class name. langchain v1 parameterized these
 * classes, so the names only come out bare if the generic arguments are
 * erased — matching what the langchain v0 line emitted. Order isn't
 * guaranteed (it follows module-graph traversal), so match membership.
 */
export const baseMessageDefinitions = {
  BaseMessage: {
    description: expect.stringContaining(
      "Base class for all types of messages",
    ),
    oneOf: expect.arrayContaining([
      { $ref: "#/definitions/AIMessage" },
      { $ref: "#/definitions/BaseMessageChunk" },
      { $ref: "#/definitions/ChatMessage" },
      { $ref: "#/definitions/FunctionMessage" },
      { $ref: "#/definitions/HumanMessage" },
      { $ref: "#/definitions/RemoveMessage" },
      { $ref: "#/definitions/SystemMessage" },
      { $ref: "#/definitions/ToolMessage" },
    ]),
  },
};
