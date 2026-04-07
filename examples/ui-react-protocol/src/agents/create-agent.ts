import { createAgent } from "langchain";

import {
  model,
  protocolSystemPrompt,
  protocolTools,
} from "./shared";

export const agent = createAgent({
  model,
  tools: [...protocolTools],
  systemPrompt: `${protocolSystemPrompt}

This runtime is the createAgent demo in the protocol testbed. Use tools when
they can make your answer more concrete, then synthesize the result into a
useful explanation or action plan.`,
});
