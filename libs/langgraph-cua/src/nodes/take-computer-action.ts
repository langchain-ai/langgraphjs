import { Scrapybara } from "scrapybara";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ComputerCallOutput, CUAState, CUAUpdate } from "../types.js";
import { initOrLoad, isComputerToolCall } from "../utils.js";

export async function takeComputerAction(
  state: CUAState,
  config: LangGraphRunnableConfig
): Promise<CUAUpdate> {
  const message = state.messages[state.messages.length - 1];
  const toolOutputs = message.additional_kwargs?.tool_outputs;
  if (!isComputerToolCall(toolOutputs)) {
    // This should never happen, but include the check for proper type narrowing.
    throw new Error(
      "Can not take computer action without a computer call in the last message."
    );
  }

  const instance = await initOrLoad(state, config);

  let streamUrl: string | undefined = state.streamUrl;
  if (!streamUrl) {
    // If the streamUrl is not yet defined in state, fetch it, then write to the custom stream
    // so that it's made accessible to the client (or whatever is reading the stream) before any actions are taken.
    streamUrl = (await instance.getStreamUrl()).streamUrl;
    config.writer?.({
      streamUrl,
    });
  }

  const action = toolOutputs[0].action;
  let computerCallOutput: ComputerCallOutput | undefined;

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
      case "keypress":
        computerResponse = await instance.computer({
          action: "press_key",
          keys: action.keys,
        });
        break;
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
        computerResponse = await instance.computer({
          action: "wait",
          // TODO: Should this be configurable? I used 2000 since it's what OpenAI has set in their example:
          // https://platform.openai.com/docs/guides/tools-computer-use#:~:text=await%20page.waitForTimeout(2000)%3B
          duration: 2000,
        });
        break;
      case "scroll":
        computerResponse = await instance.computer({
          action: "scroll",
          deltaX: action.scroll_x,
          deltaY: action.scroll_y,
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

    computerCallOutput = {
      call_id: toolOutputs[0].call_id,
      type: "computer_call_output",
      output: {
        type: "computer_screenshot",
        image_url: `data:image/png;base64,${computerResponse.base64Image}`,
      },
    };
  } catch (e) {
    console.error(
      {
        error: e,
        computerCall: toolOutputs[0],
      },
      "Failed to execute computer call."
    );
  }

  return {
    computerCallOutput,
    instanceId: instance.id,
    streamUrl,
  };
}
