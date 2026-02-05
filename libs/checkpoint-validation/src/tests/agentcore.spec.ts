import { describe } from "vitest";
import initializer from "./agentcore_initializer.js";
import { validate } from "../index.js";

describe("AgentCore Memory Checkpointer", () => {
  validate(initializer);
});
