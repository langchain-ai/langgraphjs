import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";

test(
  "runs the pinned CDN release in a native browser module",
  { timeout: 90_000 },
  async () => {
    const { server, url } = await startServer(0);
    let browser;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(url);
      await page.waitForFunction(
        () => document.querySelector("#result").dataset.status !== undefined,
        undefined,
        { timeout: 60_000 }
      );
      const result = page.locator("#result");
      const text = await result.textContent();
      assert.equal(await result.getAttribute("data-status"), "complete", text);
      assert.deepEqual(JSON.parse(text), {
        result: 42,
        checkpoint: 42,
        stream: [2, 4],
      });
      assert.deepEqual(pageErrors, []);
      assert.equal(
        await page.evaluate(() => typeof globalThis.process),
        "undefined"
      );
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);
