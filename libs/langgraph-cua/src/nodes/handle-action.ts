import type { ResponseComputerToolCall } from "openai/resources/responses/responses";
import { BrowserInstance, UbuntuInstance, WindowsInstance } from "scrapybara";
import type { KeyInput, Browser } from "puppeteer-core";
import { Provider } from "../types.js";
import { getActivePage } from "./create-vm-instance.js";

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

export const CUA_KEY_TO_PUPPETEER_KEY = {
  "/": "Slash",
  "\\": "Backslash",
  alt: "Alt",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  backspace: "Backspace",
  capslock: "CapsLock",
  cmd: "Meta",
  ctrl: "Control",
  delete: "Delete",
  end: "End",
  enter: "Enter",
  esc: "Escape",
  home: "Home",
  insert: "Insert",
  option: "Alt",
  pagedown: "PageDown",
  pageup: "PageUp",
  shift: "Shift",
  space: " ",
  super: "Meta",
  tab: "Tab",
  win: "Meta",
};

const translateKeyToPuppeteerKey = (key: string): KeyInput => {
  const lowerKey = key.toLowerCase();
  return lowerKey in CUA_KEY_TO_PUPPETEER_KEY
    ? (CUA_KEY_TO_PUPPETEER_KEY[
        lowerKey as keyof typeof CUA_KEY_TO_PUPPETEER_KEY
      ] as KeyInput)
    : (key as KeyInput);
};

const getHyperbrowserScreenshot = async (
  browser: Browser,
  waitTime: number = 3_000
) => {
  await sleep(waitTime);
  const page = await getActivePage(browser);
  const screenshot = await Promise.race([
    page.screenshot({ type: "png" }),
    new Promise<Buffer>((_, reject) => {
      setTimeout(() => reject(new Error("Screenshot timeout")), 15_000);
    }),
  ]);
  return Buffer.from(screenshot).toString("base64");
};

export async function handleClickAction(
  action: ResponseComputerToolCall.Click,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      return (
        await instance.computer({
          action: "click_mouse",
          button: action.button === "wheel" ? "middle" : action.button,
          coordinates: [action.x, action.y],
        })
      ).base64Image;
    case "hyperbrowser": {
      const page = await getActivePage(instance);
      switch (action.button) {
        case "back":
          await page.goBack({ timeout: 15_000 });
          break;
        case "forward":
          await page.goForward({ timeout: 15_000 });
          break;
        case "wheel":
          await page.mouse.wheel({ deltaX: action.x, deltaY: action.y });
          break;
        case "left":
          await page.mouse.click(action.x, action.y, { button: "left" });
          break;
        case "right":
          await page.mouse.click(action.x, action.y, { button: "right" });
          break;
        default:
          throw new Error(`Unknown button: ${action.button}`);
      }
      return await getHyperbrowserScreenshot(instance);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleDoubleClickAction(
  action: ResponseComputerToolCall.DoubleClick,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      return (
        await instance.computer({
          action: "click_mouse",
          button: "left",
          coordinates: [action.x, action.y],
          numClicks: 2,
        })
      ).base64Image;
    case "hyperbrowser": {
      const page = await getActivePage(instance);
      await page.mouse.click(action.x, action.y, {
        button: "left",
        clickCount: 2,
      });
      return await getHyperbrowserScreenshot(instance);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleDragAction(
  action: ResponseComputerToolCall.Drag,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      return (
        await instance.computer({
          action: "drag_mouse",
          path: action.path.map(({ x, y }) => [x, y]),
        })
      ).base64Image;
    case "hyperbrowser": {
      const page = await getActivePage(instance);
      if (action.path.length < 2) {
        throw new Error(
          "Invalid drag path: must contain at least a start and end point"
        );
      }

      await page.mouse.move(action.path[0].x, action.path[0].y);
      await page.mouse.down();

      for (const { x, y } of action.path) {
        await page.mouse.move(x, y);
        await sleep(40 + Math.floor(Math.random() * 40)); // Random delay between 40-79ms to simulate human dragging
      }

      await page.mouse.up();
      return await getHyperbrowserScreenshot(instance);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleKeypressAction(
  action: ResponseComputerToolCall.Keypress,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara": {
      const mappedKeys = action.keys
        .map((k) => k.toLowerCase())
        .map((key) =>
          key in CUA_KEY_TO_SCRAPYBARA_KEY
            ? CUA_KEY_TO_SCRAPYBARA_KEY[key]
            : key
        );
      return (
        await instance.computer({
          action: "press_key",
          keys: mappedKeys,
        })
      ).base64Image;
    }
    case "hyperbrowser": {
      const page = await getActivePage(instance);
      const mappedKeysHb = action.keys.map((key) =>
        translateKeyToPuppeteerKey(key)
      );
      for (const key of mappedKeysHb) {
        await page.keyboard.down(key);
      }
      for (const key of [...mappedKeysHb].reverse()) {
        await page.keyboard.up(key);
      }
      return await getHyperbrowserScreenshot(instance);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleMoveAction(
  action: ResponseComputerToolCall.Move,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      return (
        await instance.computer({
          action: "move_mouse",
          coordinates: [action.x, action.y],
        })
      ).base64Image;
    case "hyperbrowser": {
      const page = await getActivePage(instance);
      await page.mouse.move(action.x, action.y);
      return await getHyperbrowserScreenshot(instance, 1_000);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleScreenshotAction(
  _action: ResponseComputerToolCall.Screenshot,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      return (
        await instance.computer({
          action: "take_screenshot",
        })
      ).base64Image;
    case "hyperbrowser":
      return await getHyperbrowserScreenshot(instance, 0);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleWaitAction(
  _action: ResponseComputerToolCall.Wait,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      await sleep(2000);
      return (
        await instance.computer({
          action: "take_screenshot",
        })
      ).base64Image;
    case "hyperbrowser":
      return await getHyperbrowserScreenshot(instance, 2_000);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleScrollAction(
  action: ResponseComputerToolCall.Scroll,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      return (
        await instance.computer({
          action: "scroll",
          deltaX: action.scroll_x / 20,
          deltaY: action.scroll_y / 20,
          coordinates: [action.x, action.y],
        })
      ).base64Image;
    case "hyperbrowser": {
      const page = await getActivePage(instance);
      await page.mouse.move(action.x, action.y);
      await page.evaluate(
        `window.scrollBy(${action.scroll_x}, ${action.scroll_y})`
      );
      return await getHyperbrowserScreenshot(instance, 1_000);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function handleTypeAction(
  action: ResponseComputerToolCall.Type,
  provider: Provider,
  instance: UbuntuInstance | BrowserInstance | WindowsInstance | Browser
) {
  switch (provider) {
    case "scrapybara":
      return (
        await instance.computer({
          action: "type_text",
          text: action.text,
        })
      ).base64Image;
    case "hyperbrowser": {
      const page = await getActivePage(instance);
      await page.keyboard.type(action.text);
      return await getHyperbrowserScreenshot(instance, 1_000);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
