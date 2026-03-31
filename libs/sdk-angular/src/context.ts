import {
  InjectionToken,
  inject as angularInject,
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from "@angular/core";
import type { BagTemplate } from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk";
import type {
  ResolveStreamOptions,
  InferBag,
  InferStateType,
  UseStreamCustomOptions,
} from "@langchain/langgraph-sdk/ui";
import type { StreamServiceInstance } from "./stream-service-instance.js";
import { useStreamLGP } from "./stream.lgp.js";
import { injectStreamCustom } from "./stream.custom.js";

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
export const STREAM_INSTANCE = new InjectionToken<StreamServiceInstance>(
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
export function provideStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options:
    | ResolveStreamOptions<T, InferBag<T, Bag>>
    | UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
) {
  return {
    provide: STREAM_INSTANCE,
    useFactory: () => {
      const defaults = angularInject(STREAM_DEFAULTS, { optional: true });
      const merged = {
        ...(defaults ?? {}),
        ...options,
        apiUrl: (options as Record<string, unknown>).apiUrl ?? defaults?.apiUrl,
        client: (options as Record<string, unknown>).client ?? defaults?.client,
      };
      if ("transport" in merged) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return injectStreamCustom(merged as any);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return useStreamLGP(merged as any);
    },
  };
}
