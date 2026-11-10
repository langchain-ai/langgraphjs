import { webdriverio } from "@vitest/browser-webdriverio";
import { defineConfig } from "vitest/config";

const serverUrl = process.env.LANGGRAPH_SERVER_URL;
if (!serverUrl) {
  throw new Error(
    "Set LANGGRAPH_SERVER_URL to a running Python dev server, started as in the sdk-python-server job of .github/workflows/test-browser.yml"
  );
}

export default defineConfig({
  test: {
    include: ["src/react/tests/**/*.test.tsx"],
    provide: { serverUrl },
    retry: 1,
    testTimeout: 30_000,
    expect: { poll: { timeout: 10_000 } },
    browser: {
      enabled: true,
      connectTimeout: 120_000,
      provider: webdriverio(),
      instances: [{ browser: "chrome", headless: true }],
    },
  },
});
