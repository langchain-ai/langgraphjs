<script lang="ts">
  import type { Message } from "@langchain/langgraph-sdk";
  import { useStream, type AgentServerAdapter } from "../../index.js";

  type StreamState = { messages: Message[] };
  type AdapterCommand = Parameters<AgentServerAdapter["send"]>[0];
  type AdapterResponse = Awaited<ReturnType<AgentServerAdapter["send"]>>;
  type ProtocolMessage =
    ReturnType<AgentServerAdapter["events"]> extends AsyncIterable<infer T>
      ? T
      : never;

  interface Props {
    onCommand: (command: AdapterCommand) => void;
  }

  let { onCommand }: Props = $props();

  const adapter: AgentServerAdapter = {
    threadId: "custom-thread",
    async open() {},
    async send(command): Promise<AdapterResponse> {
      onCommand(command);
      return {
        type: "success",
        id: command.id,
        result: command.method === "run.start" ? { run_id: "run-custom" } : {},
      };
    },
    events() {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<ProtocolMessage>> => ({
            done: true,
            value: undefined,
          }),
        }),
      };
    },
    openEventStream() {
      return {
        ready: Promise.resolve(),
        events: {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<ProtocolMessage>> => ({
              done: true,
              value: undefined,
            }),
          }),
        },
        close() {},
      };
    },
    async close() {},
  };

  const stream = useStream<StreamState>({
    transport: adapter,
    threadId: null,
    onThreadId: () => {},
  });
</script>

<button
  data-testid="submit-custom-subgraphs"
  onclick={() =>
    void stream.submit({ messages: [{ type: "human", content: "Hi" } as Message] })}
>
  Submit
</button>
