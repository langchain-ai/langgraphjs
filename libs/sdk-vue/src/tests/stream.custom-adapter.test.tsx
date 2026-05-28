import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent, type PropType } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentServerAdapter } from "../index.js";
import type {
  Command,
  CommandResponse,
  Message,
  SubscribeParams,
} from "@langchain/protocol";

import { useStream } from "../index.js";
import { formatMessage } from "./components/format.js";

interface StreamState {
  messages: BaseMessage[];
}

type StreamRecord = {
  params: SubscribeParams;
  queue: Message[];
  waiters: Array<(result: IteratorResult<Message>) => void>;
  closed: boolean;
};

class FakeAgentServerAdapter implements AgentServerAdapter {
  readonly threadId = "custom-thread";

  readonly sentCommands: Command[] = [];

  private readonly streams = new Set<StreamRecord>();

  private readonly buffer: Message[] = [];

  private seq = 0;

  async open(): Promise<void> { }

  async send(command: Command): Promise<CommandResponse | void> {
    this.sentCommands.push(command);

    if (command.method === "run.start") {
      queueMicrotask(() => this.emitRun(command.params?.input));
      return {
        type: "success" as const,
        id: command.id,
        result: { run_id: "run_custom" },
      };
    }

    return {
      type: "success" as const,
      id: command.id,
      result: {},
    };
  }

  events(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  openEventStream(params: SubscribeParams) {
    const record: StreamRecord = {
      params,
      queue: [],
      waiters: [],
      closed: false,
    };
    this.streams.add(record);

    for (const event of this.buffer) {
      if (this.matches(event, params)) this.pushToRecord(record, event);
    }

    return {
      ready: Promise.resolve(),
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Message>> => {
            if (record.queue.length > 0) {
              return { done: false, value: record.queue.shift()! };
            }
            if (record.closed) return { done: true, value: undefined };
            return await new Promise<IteratorResult<Message>>((resolve) => {
              record.waiters.push(resolve);
            });
          },
          return: async () => {
            this.closeRecord(record);
            return { done: true as const, value: undefined };
          },
        }),
      },
      close: () => this.closeRecord(record),
    };
  }

  async close(): Promise<void> {
    for (const record of Array.from(this.streams)) {
      this.closeRecord(record);
    }
  }

  async getState(): Promise<null> {
    return null;
  }

  private emitRun(input: unknown): void {
    const messages =
      input != null &&
        typeof input === "object" &&
        Array.isArray((input as { messages?: unknown }).messages)
        ? (input as { messages: unknown[] }).messages
        : [];

    this.pushEvent("lifecycle", { event: "running" });
    this.pushEvent("values", {
      messages: [
        ...messages,
        { id: "custom-ai", type: "ai", content: "Hello from custom adapter" },
      ],
    });
    this.pushEvent("lifecycle", { event: "completed" });
  }

  private pushEvent(method: "values" | "lifecycle", data: unknown): void {
    const event = {
      type: "event",
      method,
      seq: ++this.seq,
      event_id: `custom-event-${this.seq}`,
      params: {
        namespace: [],
        timestamp: Date.now(),
        data,
      },
    } as Message;
    this.buffer.push(event);

    for (const record of this.streams) {
      if (this.matches(event, record.params)) this.pushToRecord(record, event);
    }
  }

  private matches(
    event: Message,
    params: SubscribeParams,
  ): boolean {
    if (!params.channels.includes(event.method)) return false;
    if (params.namespaces == null) return true;
    return params.namespaces.some(
      (namespace: readonly string[]) =>
        namespace.length === event.params.namespace.length &&
        namespace.every(
          (segment: string, index: number) =>
            segment === event.params.namespace[index],
        ),
    );
  }

  private pushToRecord(record: StreamRecord, event: Message): void {
    if (record.closed) return;
    const waiter = record.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    record.queue.push(event);
  }

  private closeRecord(record: StreamRecord): void {
    if (record.closed) return;
    record.closed = true;
    this.streams.delete(record);
    while (record.waiters.length > 0) {
      record.waiters.shift()?.({ done: true, value: undefined });
    }
  }
}

const CustomAdapterStream = defineComponent({
  name: "CustomAdapterStream",
  props: {
    adapter: {
      type: Object as PropType<FakeAgentServerAdapter>,
      required: true,
    },
  },
  setup(props) {
    const stream = useStream<StreamState>({
      assistantId: "customAgent",
      threadId: props.adapter.threadId,
      transport: props.adapter,
    });

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        {stream.messages.value.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({
              messages: [new HumanMessage("Hello custom")],
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
});

it("streams through a custom AgentServerAdapter via unified useStream", async () => {
  const adapter = new FakeAgentServerAdapter();
  const screen = await render(CustomAdapterStream, {
    props: { adapter },
  });

  try {
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("0");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("message-0"), { timeout: 5_000 })
      .toHaveTextContent("Hello custom");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Hello from custom adapter");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    const runCommand = adapter.sentCommands.find(
      (command) => command.method === "run.start",
    );
    expect(runCommand?.params).toMatchObject({
      assistant_id: "customAgent",
      input: {
        messages: [
          expect.objectContaining({
            content: "Hello custom",
          }),
        ],
      },
    });
  } finally {
    await screen.unmount();
  }
});
