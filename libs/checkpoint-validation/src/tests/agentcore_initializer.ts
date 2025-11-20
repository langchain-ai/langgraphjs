import { AgentCoreMemorySaver } from "@langchain/langgraph-checkpoint-aws-agentcore-memory";
import type { CheckpointerTestInitializer } from "../types.js";

export const initializer: CheckpointerTestInitializer<AgentCoreMemorySaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-aws-agentcore-memory",

  async beforeAll() {
    // No setup needed - uses existing AWS credentials and memory ID from environment
  },

  async afterAll() {
    // No cleanup needed
  },

  async createCheckpointer() {
    const { AWS_REGION, AGENTCORE_MEMORY_ID } = process.env;
    if (!AWS_REGION || !AGENTCORE_MEMORY_ID) {
      throw new Error(
        "AWS_REGION and AGENTCORE_MEMORY_ID environment variables are required"
      );
    }

    return new AgentCoreMemorySaver({
      memoryId: AGENTCORE_MEMORY_ID,
      region: AWS_REGION,
    });
  },
};

export default initializer;
