# How to add custom middleware

When deploying agents on the LangGraph platform, you can add custom middleware to your server to handle cross-cutting concerns like logging request metrics, injecting or checking headers, and enforcing security policies without modifying core server logic. This works the same way as [adding custom routes](./custom_routes.md) - you just need to provide your own [`Hono`](https://hono.dev/) app.

Adding middleware lets you intercept and modify requests globally across your deployment, whether they're hitting your custom endpoints or the built-in LangGraph Platform APIs.

???+ warning "Requests only for built-in LangGraph Platform APIs"

    Currently only intercepting and modifying requests are supported at the moment.

    You can still add custom headers to responses, but modifying response headers or response body of a built-in LangGraph Platform endpoint is not yet supported.

## Create app

Starting from an **existing** LangGraph Platform application, add the following middleware code to your `app.ts` file. If you are starting from scratch, you can create a new app from a template using the CLI.

```bash
npm create langgraph
```

Make sure to install `hono` as a dependency.

```bash
npm install hono
```

Once you have a LangGraph project, add the following app code:

```typescript
import { Hono } from "hono";

export const app = new Hono();

app.use(async (c, next) => {
  c.header("X-Custom-Header", "Hello World");
  await next();
});
```

## Configure `langgraph.json`

Add the following to your `langgraph.json` file. Make sure the path points to the `app.py` file you created above.

```json
{
  "graphs": {
    "agent": "./src/agent/graph.ts:graph"
  },
  "env": ".env",
  "http": {
    "app": "./src/agent/app.ts:app"
  }
  // Other configuration options like auth, store, etc.
}
```

## Start server

Test the server out locally:

```bash
npx langgraph-cli@latest dev --no-browser
```

Now any request to your server will include the custom header `X-Custom-Header` in its response.

## Deploying

You can deploy this app as-is to the managed LangGraph Cloud or to your self-hosted platform.

## Next steps

Now that you've added custom middleware to your deployment, you can use similar techniques to add [custom routes](./custom_routes.md).
