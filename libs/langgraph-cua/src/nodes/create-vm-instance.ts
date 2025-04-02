import { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { Browser } from "puppeteer-core";
import { connect } from "puppeteer-core";
import { UbuntuInstance, BrowserInstance, WindowsInstance } from "scrapybara";
import { SessionDetail } from "@hyperbrowser/sdk/types";
import { CUAState, CUAUpdate, getConfigurationWithDefaults } from "../types.js";
import { getHyperbrowserClient, getScrapybaraClient } from "../utils.js";

export const getActivePage = async (browser: Browser) => {
  const pages = await browser.pages();
  for (const page of pages) {
    const isHidden = await page.evaluate("document.hidden");
    if (isHidden === false) {
      return page;
    }
  }
  return pages[0];
};

async function createHyperbrowserInstance(
  state: CUAState,
  config: LangGraphRunnableConfig
): Promise<CUAUpdate> {
  const { hyperbrowserApiKey, sessionParams } =
    getConfigurationWithDefaults(config);

  if (!hyperbrowserApiKey) {
    throw new Error(
      "Hyperbrowser API key not provided. Please provide one in the configurable fields, or set it as an environment variable (HYPERBROWSER_API_KEY)"
    );
  }

  const client = getHyperbrowserClient(hyperbrowserApiKey);
  const session: SessionDetail = await client.sessions.create(sessionParams);

  if (session.wsEndpoint) {
    const browser = await connect({
      browserWSEndpoint: `${session.wsEndpoint}&keepAlive=true`,
      defaultViewport: null,
    });
    const page = await getActivePage(browser);

    if (page.url() === "about:blank") {
      await page.goto("https://www.google.com");
    }
  }

  if (!state.streamUrl) {
    // If the streamUrl is not yet defined in state, fetch it, then write to the custom stream
    // so that it's made accessible to the client (or whatever is reading the stream) before any actions are taken.
    const streamUrl = session.liveUrl;
    return {
      instanceId: session.id,
      streamUrl,
    };
  }

  return {
    instanceId: session.id,
  };
}

async function createScrapybaraInstance(
  state: CUAState,
  config: LangGraphRunnableConfig
): Promise<CUAUpdate> {
  const { scrapybaraApiKey, timeoutHours, environment, blockedDomains } =
    getConfigurationWithDefaults(config);
  if (!scrapybaraApiKey) {
    throw new Error(
      "Scrapybara API key not provided. Please provide one in the configurable fields, or set it as an environment variable (SCRAPYBARA_API_KEY)"
    );
  }
  const client = getScrapybaraClient(scrapybaraApiKey);

  let instance: UbuntuInstance | BrowserInstance | WindowsInstance;

  if (environment === "ubuntu") {
    instance = await client.startUbuntu({ timeoutHours });
  } else if (environment === "windows") {
    instance = await client.startWindows({ timeoutHours });
  } else if (environment === "web") {
    const cleanedBlockedDomains = blockedDomains.map((d) =>
      d.replace("https://", "").replace("www.", "")
    );
    instance = await client.startBrowser({
      timeoutHours,
      blockedDomains: cleanedBlockedDomains,
    });
  } else {
    throw new Error(
      `Invalid environment. Must be one of 'web', 'ubuntu', or 'windows'. Received: ${environment}`
    );
  }

  if (!state.streamUrl) {
    // If the streamUrl is not yet defined in state, fetch it, then write to the custom stream
    // so that it's made accessible to the client (or whatever is reading the stream) before any actions are taken.
    const { streamUrl } = await instance.getStreamUrl();
    return {
      instanceId: instance.id,
      streamUrl,
    };
  }

  return {
    instanceId: instance.id,
  };
}

export async function createVMInstance(
  state: CUAState,
  config: LangGraphRunnableConfig
): Promise<CUAUpdate> {
  const { instanceId } = state;
  if (instanceId) {
    // Instance already exists, no need to initialize
    return {};
  }
  const { provider } = getConfigurationWithDefaults(config);
  if (provider === "scrapybara") {
    return createScrapybaraInstance(state, config);
  } else if (provider === "hyperbrowser") {
    return createHyperbrowserInstance(state, config);
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}
