import type { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  GraphCallbackHandler,
  type GraphLifecycleEvent,
} from "../callbacks.js";

export function getGraphCallbackDispatcher(
  manager: CallbackManagerForChainRun | undefined
) {
  const handlers = manager?.handlers.filter(GraphCallbackHandler.isInstance);
  if (!handlers?.length) return undefined;

  return async (events: GraphLifecycleEvent[] | undefined) => {
    while (events?.length) {
      const event = events.shift()!;
      for (const handler of handlers) {
        const method =
          "interrupts" in event ? "handleInterrupt" : "handleResume";
        try {
          if ("interrupts" in event) {
            await handler.handleInterrupt?.(event);
          } else {
            await handler.handleResume?.(event);
          }
        } catch (error) {
          (handler.raiseError ? console.error : console.warn)(
            `Error in handler ${handler.constructor.name}, ${method}: ${error}`
          );
          if (handler.raiseError) throw error;
        }
      }
    }
  };
}
