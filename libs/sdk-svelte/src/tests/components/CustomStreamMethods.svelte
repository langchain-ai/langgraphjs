<script lang="ts">
  import { useStream, type AgentServerAdapter } from "../../index.js";
  import type { Message as StateMessage } from "@langchain/langgraph-sdk";

  type AdapterResponse = Awaited<ReturnType<AgentServerAdapter["send"]>>;
  type ProtocolMessage =
    ReturnType<AgentServerAdapter["events"]> extends AsyncIterable<infer T>
      ? T
      : never;

  interface Props {
    apiUrl: string;
  }

  const { apiUrl: _apiUrl }: Props = $props();

  function eventOf(
    method: string,
    data: unknown,
    seq: number
  ): ProtocolMessage {
    return {
      type: "event",
      method,
      seq,
      params: {
        namespace: [],
        timestamp: Date.now(),
        data,
      },
    } as ProtocolMessage;
  }

  function createLocalAdapter(): AgentServerAdapter {
    const streams = new Set<{
      push: (message: ProtocolMessage) => void;
      close: () => void;
    }>();

    const publish = (message: ProtocolMessage) => {
      for (const stream of streams) stream.push(message);
    };

    return {
      threadId: "custom-thread",
      async open() {},
      async send(command): Promise<AdapterResponse> {
        if (command.method === "run.start") {
          queueMicrotask(() => {
            publish(
              eventOf(
                "values",
                {
                  messages: [
                    { id: "human-1", type: "human", content: "Hi" },
                    { id: "ai-1", type: "ai", content: "Hello!" },
                  ],
                },
                1
              )
            );
            publish(eventOf("lifecycle", { event: "completed" }, 2));
          });
        }

        return {
          type: "success",
          id: command.id,
          result:
            command.method === "run.start" ? { run_id: "run-custom" } : {},
        };
      },
      events() {
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true, value: undefined }),
          }),
        };
      },
      openEventStream() {
        const queue: ProtocolMessage[] = [];
        const waiters: Array<
          (result: IteratorResult<ProtocolMessage>) => void
        > = [];
        let closed = false;
        const stream = {
          push(message: ProtocolMessage) {
            const waiter = waiters.shift();
            if (waiter) {
              waiter({ done: false, value: message });
            } else {
              queue.push(message);
            }
          },
          close() {
            closed = true;
            streams.delete(stream);
            while (waiters.length > 0) {
              waiters.shift()?.({ done: true, value: undefined });
            }
          },
        };
        streams.add(stream);

        return {
          ready: Promise.resolve(),
          events: {
            [Symbol.asyncIterator]: () => ({
              next: async (): Promise<IteratorResult<ProtocolMessage>> => {
                if (queue.length > 0) {
                  return { done: false, value: queue.shift()! };
                }
                if (closed) return { done: true, value: undefined };
                return await new Promise((resolve) => waiters.push(resolve));
              },
              return: async () => {
                stream.close();
                return { done: true, value: undefined };
              },
            }),
          },
          close: stream.close,
        };
      },
      async close() {
        for (const stream of Array.from(streams)) stream.close();
      },
    };
  }

  const stream = useStream<{ messages: StateMessage[] }>({
    transport: createLocalAdapter(),
    threadId: null,
    onThreadId: () => {},
  });

  let branch = $state("");
</script>

<div>
  <div data-testid="messages">
    {#each stream.values.messages ?? [] as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="branch">{branch}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hi" }] } as any)}
  >
    Submit
  </button>
  <button
    data-testid="set-branch"
    onclick={() => {
      branch = "test-branch";
    }}
  >
    Set Branch
  </button>
</div>
