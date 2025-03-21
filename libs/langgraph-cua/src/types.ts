import {
  Annotation,
  LangGraphRunnableConfig,
  MessagesAnnotation,
} from "@langchain/langgraph";

export type CUAEnvironment = "web" | "ubuntu" | "windows";

export const CUAAnnotation = Annotation.Root({
  /**
   * The message list between the user & assistant. This contains
   * messages, including the computer use calls.
   */
  messages: MessagesAnnotation.spec.messages,
  /**
   * The ID of the instance to use for this thread.
   * @default undefined
   */
  instanceId: Annotation<string | undefined>({
    reducer: (_state, update) => update,
    default: () => undefined,
  }),
  /**
   * The environment to use.
   * @default "web"
   */
  environment: Annotation<CUAEnvironment>({
    reducer: (_state, update) => update,
    default: () => "web",
  }),
  /**
   * The URL to the live-stream of the virtual machine.
   */
  streamUrl: Annotation<string | undefined>({
    reducer: (_state, update) => update,
    default: () => undefined,
  }),
});

export const CUAConfigurable = Annotation.Root({
  /**
   * The API key to use for Scrapybara.
   * @default {process.env.SCRAPYBARA_API_KEY}
   */
  scrapybaraApiKey: Annotation<string | undefined>({
    reducer: (_state, update) => update,
    default: () => process.env.SCRAPYBARA_API_KEY,
  }),
  /**
   * The number of hours to keep the virtual machine running before it times out.
   * Must be between 0.01 and 24
   * @default 1
   */
  timeoutHours: Annotation<number>({
    reducer: (_state, update) => {
      if (update < 0.01 || update > 24) {
        throw new Error("timeoutHours must be between 0.01 and 24");
      }
      return update;
    },
    default: () => 1,
  }),
});

/**
 * Gets the configuration with default values.
 *
 * @param {LangGraphRunnableConfig} config - The configuration to use.
 * @returns {typeof CUAConfigurable.State} - The configuration with default values.
 */
export function getConfigurationWithDefaults(
  config: LangGraphRunnableConfig
): typeof CUAConfigurable.State {
  return {
    scrapybaraApiKey:
      config.configurable?.scrapybaraApiKey ?? process.env.SCRAPYBARA_API_KEY,
    timeoutHours: config.configurable?.timeoutHours ?? 1,
  };
}

export type CUAState = typeof CUAAnnotation.State;
export type CUAUpdate = typeof CUAAnnotation.Update;
