import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { ScrapybaraClient } from "scrapybara";

export type CUAEnvironment = "web" | "ubuntu" | "windows";

/**
 * A computer screenshot image used with the computer use tool.
 */
export interface Output {
  /**
   * Specifies the event type. For a computer screenshot, this property is always set
   * to `computer_screenshot`.
   */
  type: "computer_screenshot";

  /**
   * The identifier of an uploaded file that contains the screenshot.
   */
  file_id?: string;

  /**
   * The URL of the screenshot image.
   */
  image_url?: string;
}

/**
 * A pending safety check for the computer call.
 */
export interface AcknowledgedSafetyCheck {
  /**
   * The ID of the pending safety check.
   */
  id: string;

  /**
   * The type of the pending safety check.
   */
  code: string;

  /**
   * Details about the pending safety check.
   */
  message: string;
}

/**
 * The output of a computer tool call.
 */
export interface ComputerCallOutput {
  /**
   * The ID of the computer tool call that produced the output.
   */
  call_id: string;

  /**
   * A computer screenshot image used with the computer use tool.
   */
  output: Output;

  /**
   * The type of the computer tool call output. Always `computer_call_output`.
   */
  type: "computer_call_output";

  /**
   * The ID of the computer tool call output.
   */
  id?: string;

  /**
   * The safety checks reported by the API that have been acknowledged by the
   * developer.
   */
  acknowledged_safety_checks?: Array<AcknowledgedSafetyCheck>;

  /**
   * The status of the message input. One of `in_progress`, `completed`, or
   * `incomplete`. Populated when input items are returned via API.
   */
  status?: "in_progress" | "completed" | "incomplete";
}

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
   * The Scrapybara client to use to access the virtual machine
   */
  scrapybaraClient: Annotation<ScrapybaraClient>,
  /**
   * The environment to use.
   * @default "web"
   */
  environment: Annotation<CUAEnvironment>({
    reducer: (_state, update) => update,
    default: () => "web",
  }),
  /**
   * The output of the most recent computer call.
   */
  computerCallOutput: Annotation<ComputerCallOutput | undefined>({
    reducer: (_state, update) => update,
    default: () => undefined,
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
  /**
   * The display height of the virtual machine.
   * @default 1024
   */
  displayHeight: Annotation<number>({
    reducer: (_state, update) => update,
    default: () => 1024,
  }),
  /**
   * The display width of the virtual machine.
   * @default 768
   */
  displayWidth: Annotation<number>({
    reducer: (_state, update) => update,
    default: () => 768,
  }),
});

export type CUAState = typeof CUAAnnotation.State;
export type CUAUpdate = typeof CUAAnnotation.Update;
