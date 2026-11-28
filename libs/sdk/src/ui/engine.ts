import type { BaseMessage } from "@langchain/core/messages";

import type { Interrupt } from "../schema.js";
import type { Message } from "../types.messages.js";
import type { StreamMode } from "../types.stream.js";
import type { BagTemplate } from "../types.template.js";
import type { ChannelEvent } from "./channels.js";
import type { MessageMetadataMap } from "./message-metadata-tracker.js";
import type { RespondOptions } from "./orchestrator.js";
import type { QueueEntry } from "./queue.js";
import type { Scope } from "./scoped.js";
import type {
  GetConfigurableType,
  GetInterruptType,
  SubagentStreamInterface,
  SubmitOptions,
} from "./types.js";

/**
 * What a framework binding reads and calls on its engine: a
 * `StreamOrchestrator` for an Agent Server, or a `CustomStreamOrchestrator`
 * for a custom transport. A custom transport has no thread or run routes, so
 * its engine has no thread to load, and no scopes or fork points.
 */
export interface StreamEngine<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> {
  readonly threadId: string | undefined;
  readonly values: StateType;
  readonly messages: (Message | BaseMessage)[];
  readonly interrupts: Interrupt<GetInterruptType<Bag>>[];
  readonly subagents: Map<string, SubagentStreamInterface>;
  readonly isLoading: boolean;
  readonly isThreadLoading: boolean;
  readonly error: unknown;
  /** Settles once the latest thread load is done. */
  readonly hydrationPromise: Promise<void>;
  /** The latest thread load's error. */
  readonly historyData: { readonly error: unknown };
  readonly scopes: { acquire(namespace: readonly string[]): Scope };
  readonly messageMetadataStore: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): MessageMetadataMap;
  };
  /** The submits waiting for the run in flight, oldest first. */
  readonly queueEntries: ReadonlyArray<QueueEntry<StateType>>;

  subscribe(listener: () => void): () => void;
  /** A version that changes with every state change. */
  getSnapshot(): number;
  /** Mark the engine in use. The returned function disposes it a tick later. */
  activate(): () => void;
  initThreadId(threadId: string | undefined): void;
  /** Show a thread, read when there are routes to read it from. */
  hydrate(threadId?: string | null): Promise<void>;
  trackStreamMode(...modes: StreamMode[]): void;
  trackMessageMetadata(): () => void;
  onChannelEvent(listener: (event: ChannelEvent) => void): () => void;
  /** Start a run with `values` as its input, or `null` to send only a command. */
  submit(
    values: unknown,
    options?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ): Promise<unknown>;
  stop(options?: { cancel?: boolean }): Promise<void>;
  respond(
    value: unknown,
    options?: RespondOptions<GetConfigurableType<Bag>> & {
      interruptId?: string;
    }
  ): Promise<void>;
  respondAll(
    responses: Record<string, unknown>,
    options?: RespondOptions<GetConfigurableType<Bag>>
  ): Promise<void>;
  resolveSubagentNamespace(toolCallId: string): Promise<string[] | undefined>;
  reconstructSubagentsIfNeeded(): void;
  cancelQueueItem(id: string): Promise<boolean>;
  clearQueue(): Promise<void>;
}
