# Deployment Options

!!! info "Prerequisites"

    - [LangGraph Platform](./langgraph_platform.md)
    - [LangGraph Server](./langgraph_server.md)

## Overview

There are 3 main options for deploying with the LangGraph Platform:

1. **[Self-Hosted](#self-hosted)**: Available for **a free trial** and **Enterprise** plan.

2. **[Cloud SaaS](#cloud-saas)**: Available for **Plus** and **Enterprise** plans.

3. **[Bring Your Own Cloud](#bring-your-own-cloud)**: Available only for **Enterprise** plans and **only on AWS**.

Please see the [LangGraph Platform Pricing](https://www.langchain.com/langgraph-platform-pricing) for more information on the different plans.

The guide below will explain the differences between the deployment options.

## Self-Hosted

!!! important

    The Self-Hosted version is only available for **a free trial** and **Enterprise** plan.

With a Self-Hosted deployment, you are responsible for managing the infrastructure, including setting up and maintaining required databases and Redis instances.

You’ll build a Docker image using the [LangGraph CLI](./langgraph_cli.md), which can then be deployed on your own infrastructure.

For more information, please see:

- [Self-Hosted Deployment how-to guide](https://langchain-ai.github.io/langgraph/how-tos/deploy-self-hosted/)

## Cloud SaaS

!!! important

    The Cloud SaaS version of LangGraph Platform is only available for **Plus** and **Enterprise** plans.

The [Cloud SaaS](./langgraph_cloud.md) version of LangGraph Platform is hosted as part of [LangSmith](https://smith.langchain.com/).

The Cloud SaaS version of LangGraph Platform provides a simple way to deploy and manage your LangGraph applications.

This deployment option provides an integration with GitHub, allowing you to deploy code from any of your repositories on GitHub.

For more information, please see:

- [Cloud SaaS Conceptual Guide](./langgraph_cloud.md)
- [How to deploy to Cloud SaaS](https://langchain-ai.github.io/langgraph/cloud/deployment/cloud.md)

## Bring Your Own Cloud

!!! important

    The Bring Your Own Cloud version of LangGraph Platform is only available for **Enterprise** plans.

This combines the best of both worlds for Cloud and Self-Hosted. We manage the infrastructure, so you don't have to, but the infrastructure all runs within your cloud. This is currently only available on AWS.

For more information please see:

- [Bring Your Own Cloud Conceptual Guide](./bring_your_own_cloud.md)

## Related

For more information please see:

- [LangGraph Platform Pricing](https://www.langchain.com/langgraph-platform-pricing)
- [Deployment how-to guides](../how-tos/index.md#deployment)
