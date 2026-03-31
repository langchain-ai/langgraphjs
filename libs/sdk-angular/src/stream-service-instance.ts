import type { Signal, WritableSignal } from "@angular/core";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  AcceptBaseMessages,
  GetConfigurableType,
  GetInterruptType,
  MessageMetadata,
  SubagentStreamInterface,
  SubmitOptions,
} from "@langchain/langgraph-sdk/ui";
import type {
  BagTemplate,
  Client,
  DefaultToolCall,
  Interrupt,
  Message,
  StreamEvent,
  StreamMode,
  ToolCallWithResult,
} from "@langchain/langgraph-sdk";

type AngularQueueInterface<T> = T extends {
  entries: infer E;
  size: infer S;
  cancel: infer C;
  clear: infer Cl;
}
  ? {
      entries: WritableSignal<E>;
      size: WritableSignal<S>;
      cancel: C;
      clear: Cl;
    }
  : T;

/**
 * Shape returned by {@link useStreamLGP} / {@link injectStreamCustom} after the
 * Angular signal wrapper — the runtime API surface for {@link StreamService}.
 *
 * Uses the same message/tool/subagent types as the underlying SDK stream
 * implementations so the object can be assigned without `as unknown`.
 */
export interface StreamServiceInstance<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> {
  values: Signal<T>;
  messages: Signal<BaseMessage[]>;
  isLoading: WritableSignal<boolean>;
  error: Signal<unknown>;
  branch: WritableSignal<string>;
  interrupt: Signal<Interrupt<GetInterruptType<Bag>> | undefined>;
  interrupts: Signal<Interrupt<GetInterruptType<Bag>>[]>;
  toolCalls: Signal<ToolCallWithResult<DefaultToolCall>[]>;
  queue: AngularQueueInterface<{
    entries: readonly {
      id: string;
      values: Partial<T> | null | undefined;
    }[];
    size: number;
    cancel: (id: string) => Promise<boolean>;
    clear: () => Promise<void>;
  }>;
  subagents: Signal<ReadonlyMap<string, SubagentStreamInterface>>;
  activeSubagents: Signal<readonly SubagentStreamInterface[]>;
  history: Signal<unknown>;
  isThreadLoading: Signal<boolean>;
  experimental_branchTree: Signal<unknown>;
  client: Client;
  assistantId: string;
  submit(
    values: AcceptBaseMessages<Exclude<T, null | undefined>> | null | undefined,
    options?: SubmitOptions<
      T extends Record<string, unknown> ? T : Record<string, unknown>,
      GetConfigurableType<Bag>
    >
  ): Promise<void>;
  stop(): Promise<void>;
  setBranch(value: string): void;
  switchThread(newThreadId: string | null): void;
  joinStream(
    runId: string,
    lastEventId?: string,
    options?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
    }
  ): Promise<void>;
  getMessagesMetadata(
    message: Message,
    index?: number
  ):
    | MessageMetadata<
        T extends Record<string, unknown> ? T : Record<string, unknown>
      >
    | undefined;
  getToolCalls(message: Message): ToolCallWithResult<DefaultToolCall>[];
  getSubagent(toolCallId: string): SubagentStreamInterface | undefined;
  getSubagentsByType(type: string): SubagentStreamInterface[];
  getSubagentsByMessage(messageId: string): SubagentStreamInterface[];
}
