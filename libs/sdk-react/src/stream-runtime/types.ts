import type { StreamEvent, StreamMode } from "@langchain/langgraph-sdk";
import type {
  EventStreamEvent,
  RunCallbackMeta,
} from "@langchain/langgraph-sdk/ui";
import type { SubmitOptions } from "../types.js";

interface StreamRuntimeSubmitArgs<
  StateType extends Record<string, unknown>,
  UpdateType,
  ConfigurableType extends Record<string, unknown>,
> {
  assistantId: string;
  threadId: string;
  input: UpdateType | null | undefined;
  submitOptions?: SubmitOptions<StateType, ConfigurableType>;
  signal: AbortSignal;
  streamMode: StreamMode[];
  onRunCreated?: (run: RunCallbackMeta) => void;
}

interface StreamRuntimeJoinArgs {
  threadId: string;
  runId: string;
  signal: AbortSignal;
  lastEventId?: string;
  streamMode?: StreamMode | StreamMode[];
}

export interface StreamRuntime<
  StateType extends Record<string, unknown>,
  UpdateType,
  ConfigurableType extends Record<string, unknown>,
  CustomType,
> {
  submit(
    args: StreamRuntimeSubmitArgs<StateType, UpdateType, ConfigurableType>
  ): Promise<
    AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>
  >;
  join(
    args: StreamRuntimeJoinArgs
  ): Promise<
    AsyncGenerator<{ id?: string; event: StreamEvent; data: unknown }>
  >;
  respond(args: { interruptId: string; response: unknown }): Promise<void>;
}
