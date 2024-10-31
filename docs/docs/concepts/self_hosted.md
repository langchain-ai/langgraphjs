# Self-Hosted

!!! note Prerequisites

    - [LangGraph Platform](./langgraph_platform.md)
    - [Deployment Options](./deployment_options.md)

## Versions

There are two versions of the self hosted deployment: [Self-Hosted Enterprise](./deployment_options.md#self-hosted-enterprise) and [Self-Hosted Lite](./deployment_options.md#self-hosted-lite).

### Self-Hosted Lite

The Self-Hosted Lite version is a limited version of LangGraph Platform that you can run locally or in a self-hosted manner (up to 1 million nodes executed).

When using the Self-Hosted Lite version, you authenticate with a [LangSmith](https://smith.langchain.com/) API key.

### Self-Hosted Enterprise

The Self-Hosted Enterprise version is the full version of LangGraph Platform.

To use the Self-Hosted Enterprise version, you must acquire a license key that you will need to pass in when running the Docker image. To acquire a license key, please email sales@langchain.dev.

## Requirements

- You use `langgraph-cli` and/or [LangGraph Studio](./langgraph_studio.md) app to test graph locally.
- You use `langgraph build` command to build image.

## How it works

- Deploy Redis and Postgres instances on your own infrastructure.
- Build the docker image for [LangGraph Server](./langgraph_server.md) using the [LangGraph CLI](./langgraph_cli.md)
- Deploy a web server that will run the docker image and pass in the necessary environment variables.

See the [how-to guide](../how-tos/deploy-self-hosted.md)
