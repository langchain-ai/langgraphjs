# LangGraph from a CDN

This example loads the published `@langchain/langgraph@1.7.1` browser entrypoint through jsDelivr's ESM transformation. The page uses a native import map and ES modules, with no local bundling or transpilation. Its graph doubles a number, streams state values, and reads an in-memory checkpoint. No model or API key is needed.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @examples/browser-cdn start
```

Open the printed localhost URL. The result is:

```json
{
  "result": 42,
  "checkpoint": 42,
  "stream": [2, 4]
}
```

Any static HTTP server can serve this directory. Node is only used by the development server and test runner; graph execution happens in the browser.

## Verify the published release

```sh
pnpm --filter @examples/browser-cdn exec playwright install chromium
pnpm --filter @examples/browser-cdn test:cdn
```

The smoke test opens the actual page in Chromium and checks invocation, streaming, and checkpoint reads. It requires network access to jsDelivr and its transformed dependencies. Run it explicitly when updating the pinned version; it exercises the release selected by the import map, independently of local source changes.

The same check is available through the manually triggered **Browser CDN smoke test** GitHub Actions workflow.

Coverage is limited to those APIs on the pinned release and CDN transformation. Additional APIs, framework bindings, providers, and other CDNs need their own compatibility checks. Version the import-map URL deliberately and rerun the test when changing it.

Related discussion: [LangGraph.js #2502](https://github.com/langchain-ai/langgraphjs/issues/2502).
