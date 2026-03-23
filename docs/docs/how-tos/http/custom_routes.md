# How to add custom routes

When deploying agents on the LangGraph platform, your server automatically exposes routes for creating runs and threads, interacting with the long-term memory store, managing configurable assistants, and other core functionality ([see all default API endpoints](https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html)).

You can add custom routes by providing your own [`Hono`](https://hono.dev/) app. You make LangGraph Platform aware of this by providing a path to the app in your `langgraph.json` configuration file. (`"http": {"app": "path/to/app.ts:app"}`).

Defining a custom app object lets you add any routes you'd like, so you can do anything from adding a `/login` endpoint to writing an entire full-stack web-app, all deployed in a single LangGraph deployment.

## Create app

Starting from an **existing** LangGraph Platform application, add the following custom route code to your `app.ts` file. If you are starting from scratch, you can create a new app from a template using the CLI.

```bash
npm create langgraph
```

Make sure to install `hono` as a dependency.

```bash
npm install hono
```

Once you have a LangGraph project, add the following app code:

```typescript
// ./src/agent/app.ts
import { Hono } from "hono";

export const app = new Hono();

app.get("/hello", (c) => c.json({ hello: "world" }));
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

If you navigate to `localhost:2024/hello` in your browser (2024 is the default development port), you should see the `hello` endpoint returning `{"hello": "world"}`.

!!! note "Shadowing default endpoints"

    The routes you create in the app are given priority over the system defaults, meaning you can shadow and redefine the behavior of any default endpoint.

## Multiple apps

You can mount multiple Hono apps at different path prefixes using `http.apps`. This is useful for composing third-party extensions, dashboards, or integrations alongside your agent's built-in API.

Each entry in `http.apps` maps a URL path prefix to an app module path. The module path uses the same `file:export` format as `http.app`, and also supports npm package references.

### Example

Suppose you have a local dashboard app and want to mount a third-party extension from an npm package:

```typescript
// ./src/dashboard/app.ts
import { Hono } from "hono";

export const app = new Hono();

app.get("/", (c) => c.json({ status: "ok", agents: ["agent"] }));
app.get("/metrics", (c) => c.json({ runs: 42 }));
```

Configure them in `langgraph.json`:

```json
{
  "graphs": {
    "agent": "./src/agent/graph.ts:graph"
  },
  "http": {
    "app": "./src/agent/app.ts:app",
    "apps": {
      "/dashboard": "./src/dashboard/app.ts:app",
      "/ext": "my-extension-package:app"
    }
  }
}
```

With this configuration:

- Routes from `http.app` are mounted at `/` (root), as before.
- The dashboard app's routes are available under `/dashboard/` (e.g., `/dashboard/metrics`).
- The extension's routes are available under `/ext/`.
- The built-in LangGraph API (`/runs`, `/threads`, etc.) remains available at the root.

!!! tip "npm packages as apps"

    When the module path doesn't start with `.` or `/`, it is resolved as an npm package import. Install the package in your project's `package.json` and reference it directly (e.g., `"my-extension-package:app"`).

## Deploying

You can deploy this app as-is to the managed LangGraph Cloud or to your self-hosted platform.

## Next steps

Now that you've added a custom route to your deployment, you can use this same technique to further customize how your server behaves, such as defining [custom middleware](./custom_middleware.md).
