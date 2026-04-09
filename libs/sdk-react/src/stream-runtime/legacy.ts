import type { Client, StreamEvent } from "@langchain/langgraph-sdk";
import type { EventStreamEvent } from "@langchain/langgraph-sdk/ui";
import type { StreamRuntime } from "./types.js";

export class LegacyStreamRuntime<
  StateType extends Record<string, unknown>,
  UpdateType,
  ConfigurableType extends Record<string, unknown>,
  CustomType,
> implements StreamRuntime<StateType, UpdateType, ConfigurableType, CustomType>
{
  constructor(
    private readonly client: Client<StateType, UpdateType, CustomType>,
  ) {}

  async submit({
    assistantId,
    threadId,
    input,
    submitOptions,
    signal,
    streamMode,
    onRunCreated,
  }: Parameters<StreamRuntime<
    StateType,
    UpdateType,
    ConfigurableType,
    CustomType
  >["submit"]>[0]): Promise<
    AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>
  > {
    return this.client.runs.stream(threadId, assistantId, {
      input: input as Record<string, unknown> | null | undefined,
      config: submitOptions?.config,
      context: submitOptions?.context,
      command: submitOptions?.command,
      interruptBefore: submitOptions?.interruptBefore,
      interruptAfter: submitOptions?.interruptAfter,
      metadata: submitOptions?.metadata,
      multitaskStrategy: submitOptions?.multitaskStrategy,
      onCompletion: submitOptions?.onCompletion,
      onDisconnect: submitOptions?.onDisconnect,
      signal,
      checkpoint: submitOptions?.checkpoint ?? undefined,
      streamMode,
      streamSubgraphs: submitOptions?.streamSubgraphs,
      streamResumable: submitOptions?.streamResumable,
      durability: submitOptions?.durability,
      onRunCreated: onRunCreated == null
        ? undefined
        : (params) => {
            if (params.thread_id == null) {
              return;
            }
            onRunCreated({
              run_id: params.run_id,
              thread_id: params.thread_id,
            });
          },
    }) as AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>;
  }

  async join({
    threadId,
    runId,
    signal,
    lastEventId,
    streamMode,
  }: Parameters<
    StreamRuntime<StateType, UpdateType, ConfigurableType, CustomType>["join"]
  >[0]): Promise<AsyncGenerator<{ id?: string; event: StreamEvent; data: unknown }>> {
    return this.client.runs.joinStream(threadId, runId, {
      signal,
      lastEventId,
      streamMode,
    }) as AsyncGenerator<{ id?: string; event: StreamEvent; data: unknown }>;
  }
}
