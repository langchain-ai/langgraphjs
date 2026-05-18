import {
  InjectionToken,
  inject as angularInject,
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from "@angular/core";
import { Client } from "@langchain/langgraph-sdk";
import type { InferStateType } from "@langchain/langgraph-sdk/stream";
import {
  useStream,
  type StreamApi,
  type UseStreamOptions,
} from "./use-stream.js";

export type InferRecordState<T> =
  InferStateType<T> extends object
    ? { [K in keyof InferStateType<T>]: InferStateType<T>[K] }
    : Record<string, unknown>;

/**
 * Configuration defaults for `useStream` and `injectStream` calls.
 */
export interface StreamDefaults {
  /** Base URL of the LangGraph API. */
  apiUrl?: string;
  /** API key for authenticating with the LangGraph API. */
  apiKey?: string;
  /** Pre-configured Client instance. */
  client?: Client;
}

/**
 * Injection token for stream default configuration.
 * Provide via `provideStreamDefaults()` in your application config.
 */
export const STREAM_DEFAULTS = new InjectionToken<StreamDefaults>(
  "LANGCHAIN_STREAM_DEFAULTS"
);

/**
 * Injection token for a shared stream instance.
 * Provide via `provideStream()` at the component level.
 */
export const STREAM_INSTANCE = new InjectionToken<StreamApi>(
  "LANGCHAIN_STREAM_INSTANCE"
);

/**
 * Provides default LangGraph configuration at the application level.
 *
 * Use this in your application's `providers` array to set defaults like
 * `apiUrl` that will be used by all `useStream` and `injectStream` calls.
 *
 * @example
 * ```typescript
 * // app.config.ts
 * import { ApplicationConfig } from "@angular/core";
 * import { provideStreamDefaults } from "@langchain/angular";
 *
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideStreamDefaults({
 *       apiUrl: "http://localhost:2024",
 *     }),
 *   ],
 * };
 * ```
 */
export function provideStreamDefaults(
  defaults: StreamDefaults
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: STREAM_DEFAULTS, useValue: defaults },
  ]);
}

/**
 * Creates a provider for a shared `useStream` instance at the component level.
 *
 * Add the returned provider to a component's `providers` array so that all
 * child components can access the same stream via `injectStream()`.
 *
 * @example
 * ```typescript
 * import { Component } from "@angular/core";
 * import { provideStream, injectStream } from "@langchain/angular";
 *
 * @Component({
 *   providers: [provideStream({ assistantId: "agent" })],
 *   template: `
 *     <app-message-list />
 *     <app-message-input />
 *   `,
 * })
 * export class ChatContainer {}
 *
 * // In child components:
 * @Component({
 *   template: `
 *     @for (msg of stream.messages(); track msg.id) {
 *       <div>{{ msg.content }}</div>
 *     }
 *   `,
 * })
 * export class MessageListComponent {
 *   stream = injectStream();
 * }
 * ```
 */
export function provideStream<T = Record<string, unknown>>(
  options: UseStreamOptions<InferStateType<T>>
) {
  return {
    provide: STREAM_INSTANCE,
    useFactory: () => {
      const defaults = angularInject(STREAM_DEFAULTS, { optional: true });
      return useStream(mergeDefaults(options, defaults));
    },
  };
}

function mergeDefaults<S extends object>(
  options: UseStreamOptions<S>,
  defaults: StreamDefaults | null | undefined
): UseStreamOptions<S> {
  if (defaults == null) return options;
  if (
    (options as { transport?: unknown }).transport != null &&
    typeof (options as { transport: unknown }).transport !== "string"
  ) {
    return options;
  }
  const bag = options as unknown as Record<string, unknown>;
  return {
    ...bag,
    apiUrl: bag.apiUrl ?? defaults.apiUrl,
    apiKey: bag.apiKey ?? defaults.apiKey,
    client: bag.client ?? defaults.client,
  } as unknown as UseStreamOptions<S>;
}
