import {
  BrowserInstance,
  UbuntuInstance,
  WindowsInstance,
  Scrapybara,
} from "scrapybara";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { BaseMessageLike } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { CUAState, CUAUpdate, getConfigurationWithDefaults } from "../types.js";
import { getInstance, getToolOutputs } from "../utils.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Copied from the OpenAI example repository
// https://github.com/openai/openai-cua-sample-app/blob/eb2d58ba77ffd3206d3346d6357093647d29d99c/computers/scrapybara.py#L10
const CUA_KEY_TO_SCRAPYBARA_KEY: Record<string, string> = {
  "/": "slash",
  "\\": "backslash",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "BackSpace",
  capslock: "Caps_Lock",
  cmd: "Meta_L",
  delete: "Delete",
  end: "End",
  enter: "Return",
  esc: "Escape",
  home: "Home",
  insert: "Insert",
  option: "Alt_L",
  pagedown: "Page_Down",
  pageup: "Page_Up",
  tab: "Tab",
  win: "Meta_L",
};

const isBrowserInstance = (
  instance: UbuntuInstance | BrowserInstance | WindowsInstance
): instance is BrowserInstance =>
  "authenticate" in instance && typeof instance.authenticate === "function";

export async function takeComputerAction(
  state: CUAState,
  config: LangGraphRunnableConfig,
  {
    uploadScreenshot,
  }: { uploadScreenshot?: (screenshot: string) => Promise<string> }
): Promise<CUAUpdate> {
  if (!state.instanceId) {
    throw new Error("Can not take computer action without an instance ID.");
  }
  const { authStateId } = getConfigurationWithDefaults(config);

  const message = state.messages[state.messages.length - 1];
  const toolOutputs = getToolOutputs(message);
  if (!toolOutputs?.length) {
    // This should never happen, but include the check for proper type narrowing.
    throw new Error(
      "Can not take computer action without a computer call in the last message."
    );
  }

  const instance = await getInstance(state.instanceId, config);

  let { authenticatedId } = state;
  if (
    isBrowserInstance(instance) &&
    authStateId &&
    (!authenticatedId || authenticatedId !== authStateId)
  ) {
    await instance.authenticate({
      authStateId,
    });
    authenticatedId = authStateId;
  }

  let { streamUrl } = state;
  if (!streamUrl) {
    // If the streamUrl is not yet defined in state, fetch it, then write to the custom stream
    // so that it's made accessible to the client (or whatever is reading the stream) before any actions are taken.
    streamUrl = (await instance.getStreamUrl()).streamUrl;
    config.writer?.({
      streamUrl,
    });
  }

  const output = toolOutputs[toolOutputs.length - 1];
  const { action } = output;
  let computerCallToolMsg: BaseMessageLike | undefined;

  try {
    let computerResponse: Scrapybara.ComputerResponse;
    switch (action.type) {
      case "click":
        computerResponse = await instance.computer({
          action: "click_mouse",
          button: action.button === "wheel" ? "middle" : action.button,
          coordinates: [action.x, action.y],
        });
        break;
      case "double_click":
        computerResponse = await instance.computer({
          action: "click_mouse",
          button: "left",
          coordinates: [action.x, action.y],
          numClicks: 2,
        });
        break;
      case "drag":
        computerResponse = await instance.computer({
          action: "drag_mouse",
          path: action.path.map(({ x, y }) => [x, y]),
        });
        break;
      case "keypress": {
        const mappedKeys = action.keys
          .map((k) => k.toLowerCase())
          .map((key) =>
            key in CUA_KEY_TO_SCRAPYBARA_KEY
              ? CUA_KEY_TO_SCRAPYBARA_KEY[key]
              : key
          );
        computerResponse = await instance.computer({
          action: "press_key",
          keys: mappedKeys,
        });
        break;
      }
      case "move":
        computerResponse = await instance.computer({
          action: "move_mouse",
          coordinates: [action.x, action.y],
        });
        break;
      case "screenshot":
        computerResponse = await instance.computer({
          action: "take_screenshot",
        });
        break;
      case "wait":
        await sleep(2000);
        computerResponse = await instance.computer({
          action: "take_screenshot",
        });
        break;
      case "scroll":
        computerResponse = await instance.computer({
          action: "scroll",
          deltaX: action.scroll_x / 20,
          deltaY: action.scroll_y / 20,
          coordinates: [action.x, action.y],
        });
        break;
      case "type":
        computerResponse = await instance.computer({
          action: "type_text",
          text: action.text,
        });
        break;
      default:
        throw new Error(
          `Unknown computer action received: ${JSON.stringify(action, null, 2)}`
        );
    }

    let screenshotContent = `data:image/png;base64,${computerResponse.base64Image}`;
    if (uploadScreenshot) {
      const uploadScreenshotRunnable = RunnableLambda.from(
        uploadScreenshot
      ).withConfig({ runName: "upload-screenshot" });
      screenshotContent = await uploadScreenshotRunnable.invoke(
        screenshotContent
      );
    }

    computerCallToolMsg = {
      type: "tool",
      tool_call_id: output.call_id,
      additional_kwargs: { type: "computer_call_output" },
      content: screenshotContent,
    };
  } catch (e) {
    console.error(
      {
        error: e,
        computerCall: output,
      },
      "Failed to execute computer call."
    );
  }

  return {
    messages: computerCallToolMsg ? [computerCallToolMsg] : [],
    instanceId: instance.id,
    streamUrl,
    authenticatedId,
  };
}
