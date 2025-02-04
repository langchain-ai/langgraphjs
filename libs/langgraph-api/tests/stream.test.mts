import { Client } from "@langchain/langgraph-sdk";
import { describe, it } from "vitest";
import { z } from "zod";

const API_URL = "http://localhost:2024";
const client = new Client({ apiUrl: API_URL });

it("stream", async () => {
  const assistant = await client.assistants.create({ graphId: "agent" });
  const thread = await client.threads.create();

  const run = await client.runs.stream(
    thread.thread_id,
    assistant.assistant_id,
    {
      input: {
        messages: [{ type: "human", content: "foo", id: "initial-message" }],
      },
      config: {
        configurable: { user_id: "123" },
      },
      streamMode: ["messages", "messages-tuple", "updates", "events", "debug"],
    }
  );

  for await (const chunk of run) {
    console.log(chunk);
  }
});
