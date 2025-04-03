import { BrowserInstance, UbuntuInstance, WindowsInstance } from "scrapybara";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { connect } from "puppeteer-core";
import { BaseMessageLike } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { CUAState, CUAUpdate, getConfigurationWithDefaults } from "../types.js";
import {
  getHyperbrowserInstance,
  getScrapybaraInstance,
  getToolOutputs,
} from "../utils.js";
import {
  handleClickAction,
  handleDoubleClickAction,
  handleDragAction,
  handleKeypressAction,
  handleMoveAction,
  handleScreenshotAction,
  handleScrollAction,
  handleTypeAction,
  handleWaitAction,
} from "./handle-action.js";

const isBrowserInstance = (
  instance: UbuntuInstance | BrowserInstance | WindowsInstance
): instance is BrowserInstance =>
  "authenticate" in instance && typeof instance.authenticate === "function";

async function scrapybaraSetup(
  instanceId: string,
  state: CUAState,
  config: LangGraphRunnableConfig
) {
  const instance = await getScrapybaraInstance(instanceId, config);
  const { authStateId } = getConfigurationWithDefaults(config);

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

  return {
    instance,
    updatedState: {
      instanceId: instance.id,
      streamUrl,
      authenticatedId,
    },
  };
}

async function hyperbrowserSetup(
  instanceId: string,
  state: CUAState,
  config: LangGraphRunnableConfig
) {
  const instance = await getHyperbrowserInstance(instanceId, config);
  let { streamUrl } = state;

  const browser = await connect({
    browserWSEndpoint: `${instance.wsEndpoint}&keepAlive=true`,
    defaultViewport: null,
  });

  if (!streamUrl) {
    streamUrl = instance.liveUrl;
    config.writer?.({
      streamUrl,
    });
  }

  return {
    instance: browser,
    updatedState: {
      instanceId: instance.id,
      streamUrl,
    },
  };
}

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

  const message = state.messages[state.messages.length - 1];
  const toolOutputs = getToolOutputs(message);
  if (!toolOutputs?.length) {
    // This should never happen, but include the check for proper type narrowing.
    throw new Error(
      "Can not take computer action without a computer call in the last message."
    );
  }
  const { provider } = getConfigurationWithDefaults(config);

  const { instance, updatedState } = await (provider === "scrapybara"
    ? scrapybaraSetup(state.instanceId, state, config)
    : hyperbrowserSetup(state.instanceId, state, config));

  const output = toolOutputs[toolOutputs.length - 1];
  const { action } = output;
  let computerCallToolMsg: BaseMessageLike | undefined;

  try {
    let responseScreenshot: string | undefined;
    switch (action.type) {
      case "click":
        responseScreenshot = await handleClickAction(
          action,
          provider,
          instance
        );
        break;
      case "double_click":
        responseScreenshot = await handleDoubleClickAction(
          action,
          provider,
          instance
        );
        break;
      case "drag":
        responseScreenshot = await handleDragAction(action, provider, instance);
        break;
      case "keypress":
        responseScreenshot = await handleKeypressAction(
          action,
          provider,
          instance
        );
        break;
      case "move":
        responseScreenshot = await handleMoveAction(action, provider, instance);
        break;
      case "screenshot":
        responseScreenshot = await handleScreenshotAction(
          action,
          provider,
          instance
        );
        break;
      case "wait":
        responseScreenshot = await handleWaitAction(action, provider, instance);
        break;
      case "scroll":
        responseScreenshot = await handleScrollAction(
          action,
          provider,
          instance
        );
        break;
      case "type":
        responseScreenshot = await handleTypeAction(action, provider, instance);
        break;
      default:
        throw new Error(
          `Unknown computer action received: ${JSON.stringify(action, null, 2)}`
        );
    }

    if (!responseScreenshot) {
      throw new Error("No screenshot returned from computer action.");
    }

    let screenshotContent = `data:image/png;base64,${responseScreenshot}`;
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
    ...updatedState,
    messages: computerCallToolMsg ? [computerCallToolMsg] : [],
  };
}
