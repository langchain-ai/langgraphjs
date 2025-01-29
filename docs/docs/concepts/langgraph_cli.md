# LangGraph.js CLI

!!! info "Prerequisites"
    - [LangGraph Platform](./langgraph_platform.md)
    - [LangGraph Server](./langgraph_server.md)

The LangGraph.js CLI is a multi-platform command-line tool for building and running the [LangGraph.js API server](./langgraph_server.md) locally. This offers an alternative to the [LangGraph Studio desktop app](./langgraph_studio.md) for developing and testing agents across all major operating systems (Linux, Windows, MacOS). The resulting server includes all API endpoints for your graph's runs, threads, assistants, etc. as well as the other services required to run your agent, including a managed database for checkpointing and storage.

## Installation

The LangGraph.js CLI can be installed from the NPM registry:

=== "npx"
    ```bash
    npx @langchain/langgraph-cli
    ```

=== "npm"
    ```bash
    npm install @langchain/langgraph-cli
    ```

=== "yarn"
    ```bash
    yarn add @langchain/langgraph-cli
    ```

=== "pnpm"
    ```bash
    pnpm add @langchain/langgraph-cli
    ```

=== "bun"
    ```bash
    bun add @langchain/langgraph-cli
    ```

## Commands

The CLI provides the following core functionality:

### `build`

The `langgraph build` command builds a Docker image for the [LangGraph API server](./langgraph_server.md) that can be directly deployed.

### `dev`

The `langgraph dev` command starts a lightweight development server that requires no Docker installation. This server is ideal for rapid development and testing, with features like:

- Hot reloading: Changes to your code are automatically detected and reloaded
- In-memory state with local persistence: Server state is stored in memory for speed but persisted locally between restarts

**Note**: This command is intended for local development and testing only. It is not recommended for production use.

### `up`

The `langgraph up` command starts an instance of the [LangGraph API server](./langgraph_server.md) locally in a docker container. This requires the docker server to be running locally. It also requires a LangSmith API key for local development or a license key for production use.

The server includes all API endpoints for your graph's runs, threads, assistants, etc. as well as the other services required to run your agent, including a managed database for checkpointing and storage.

### `dockerfile`

The `langgraph dockerfile` command generates a [Dockerfile](https://docs.docker.com/reference/dockerfile/) that can be used to build images for and deploy instances of the [LangGraph API server](./langgraph_server.md). This is useful if you want to further customize the dockerfile or deploy in a more custom way.


??? note "Updating your langgraph.json file"
    The `langgraph dockerfile` command translates all the configuration in your `langgraph.json` file into Dockerfile commands. When using this command, you will have to re-run it whenever you update your `langgraph.json` file. Otherwise, your changes will not be reflected when you build or run the dockerfile.

## Related

- [LangGraph CLI API Reference](/langgraphjs/cloud/reference/cli/)
