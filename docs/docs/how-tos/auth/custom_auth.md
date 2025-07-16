# How to add custom authentication

!!! tip "Prerequisites"

    This guide assumes familiarity with the following concepts:

      *  [**Authentication & Access Control**](../../concepts/auth.md)
      *  [**LangGraph Platform**](../../concepts/index.md#langgraph-platform)

???+ note "Support by deployment type"

    Custom auth is supported for all deployments in the **managed LangGraph Cloud**, as well as **Enterprise** self-hosted plans. It is not supported for **Lite** self-hosted plans.

This guide shows how to add custom authentication to your LangGraph Platform application. This guide applies to both LangGraph Cloud, BYOC, and self-hosted deployments. It does not apply to isolated usage of the LangGraph open source library in your own custom server.

## 1. Implement authentication

```typescript
import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";

export const auth = new Auth()
  .authenticate(async (request: Request) => {
    const authorization = request.headers.get("authorization");
    const token = authorization?.split(" ").at(-1);

    try {
      const userId = (await verifyToken(token)) as string;
      return userId;
    } catch (error) {
      throw new HTTPException(401, { message: "Invalid token", cause: error });
    }
  })
  .on("*", ({ value, user }) => {
    // Add owner to the resource metadata
    if ("metadata" in value) {
      value.metadata ??= {};
      value.metadata.owner = user.identity;
    }

    // Filter the resource by the owner
    return { owner: user.identity };
  })
  .on("store", ({ user, value }) => {
    if (value.namespace != null) {
      // Assuming you organize information in store like (user_id, resource_type, resource_id)
      const [userId, resourceType, resourceId] = value.namespace;
      if (userId !== user.identity) {
        throw new HTTPException(403, { message: "Not authorized" });
      }
    }
  });
```

## 2. Update configuration

In your `langgraph.json`, add the path to your auth file:

```json hl_lines="7-9"
{
  "node_version": "20",
  "graphs": {
    "agent": "./agent.mts:graph"
  },
  "env": ".env",
  "auth": {
    "path": "./auth.mts:auth"
  }
}
```

## 3. Connect from the client

Once you've set up authentication in your server, requests must include the required authorization information based on your chosen scheme.
Assuming you are using JWT token authentication, you could access your deployments using any of the following methods:

=== "Python Client"

    ```python
    from langgraph_sdk import get_client

    my_token = "your-token" # In practice, you would generate a signed token with your auth provider
    client = get_client(
        url="http://localhost:2024",
        headers={"Authorization": f"Bearer {my_token}"}
    )
    threads = await client.threads.search()
    ```

=== "Python RemoteGraph"

    ```python
    from langgraph.pregel.remote import RemoteGraph

    my_token = "your-token" # In practice, you would generate a signed token with your auth provider
    remote_graph = RemoteGraph(
        "agent",
        url="http://localhost:2024",
        headers={"Authorization": f"Bearer {my_token}"}
    )
    threads = await remote_graph.ainvoke(...)
    ```

=== "JavaScript Client"

    ```javascript
    import { Client } from "@langchain/langgraph-sdk";

    const my_token = "your-token"; // In practice, you would generate a signed token with your auth provider
    const client = new Client({
      apiUrl: "http://localhost:2024",
      headers: { Authorization: `Bearer ${my_token}` },
    });
    const threads = await client.threads.search();
    ```

=== "JavaScript RemoteGraph"

    ```javascript
    import { RemoteGraph } from "@langchain/langgraph/remote";

    const my_token = "your-token"; // In practice, you would generate a signed token with your auth provider
    const remoteGraph = new RemoteGraph({
      graphId: "agent",
      url: "http://localhost:2024",
      headers: { Authorization: `Bearer ${my_token}` },
    });
    const threads = await remoteGraph.invoke(...);
    ```

=== "CURL"

    ```bash
    curl -H "Authorization: Bearer ${your-token}" http://localhost:2024/threads
    ```

### Authorizing a Studio user

By default, if you add custom authorization on your resources, this will also apply to interactions made from the Studio. If you want, you can handle logged-in Studio users in a special way with [isStudioUser()](../../reference/functions/sdk_auth.isStudioUser.html).

```typescript
import { Auth, isStudioUser } from "@langchain/langgraph-sdk/auth";

export const auth = new Auth().on("*", ({ value, user }) => {
  // If the request is made using LangSmith API-key auth
  if (isStudioUser(user)) {
    // E.g., allow all requests
    return {};
  }

  // Otherwise, apply regular authorization logic ...
  if ("metadata" in value) {
    value.metadata ??= {};
    value.metadata.owner = user.identity;
  }

  // Filter the resource by the owner
  return { owner: user.identity };
});
```

Only use this if you want to permit developer access to a graph deployed on the managed LangGraph Platform SaaS.
