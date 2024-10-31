# LangGraph Studio

!!! info "Prerequisites"

    - [LangGraph Platform](./langgraph_platform.md)
    - [LangGraph Server](./langgraph_server.md)

LangGraph Studio offers a new way to develop LLM applications by providing a specialized agent IDE that enables visualization, interaction, and debugging of complex agentic applications.

With visual graphs and the ability to edit state, you can better understand agent workflows and iterate faster. LangGraph Studio integrates with LangSmith allowing you to  collaborate with teammates to debug failure modes.

![](img/lg_studio.png)

## Features

The key features of LangGraph Studio are:

- Visualizes your graph
- Test your graph by running it from the UI
- Debug your agent by [modifying its state and rerunning](human_in_the_loop.md)
- Create and manage [assistants](assistants.md)
- View and manage [threads](persistence.md#threads)
- View and manage [long term memory](memory.md)
- Add node input/outputs to [LangSmith](https://smith.langchain.com/) datasets for testing

## Types

### Desktop app

LangGraph Studio is available as a [desktop app](https://studio.langchain.com/) for MacOS users.

While in Beta, LangGraph Studio is available for free to all [LangSmith](https://smith.langchain.com/) users on any plan tier.

### Cloud studio

If you have deployed your LangGraph application on LangGraph Platform (Cloud), you can access the studio as part of that

## Studio FAQs

### Why is my project failing to start?

There are a few reasons that your project might fail to start, here are some of the most common ones.

#### Docker issues (desktop only)

LangGraph Studio (desktop) requires Docker Desktop version 4.24 or higher. Please make sure you have a version of Docker installed that satisfies that requirement and also make sure you have the Docker Desktop app up and running before trying to use LangGraph Studio. In addition, make sure you have docker-compose updated to version 2.22.0 or higher.

#### Configuration or environment issues

Another reason your project might fail to start is because your configuration file is defined incorrectly, or you are missing required environment variables. 

### How does interrupt work?

When you select the `Interrupts` dropdown and select a node to interrupt the graph will pause execution before and after (unless the node goes straight to `END`) that node has run. This means that you will be able to both edit the state before the node is ran and the state after the node has ran. This is intended to allow developers more fine-grained control over the behavior of a node and make it easier to observe how the node is behaving. You will not be able to edit the state after the node has ran if the node is the final node in the graph.

### How do I reload the app?  (desktop only)

If you would like to reload the app, don't use Command+R as you might normally do. Instead, close and reopen the app for a full refresh.

### How does automatic rebuilding work?  (desktop only)

One of the key features of LangGraph Studio is that it automatically rebuilds your image when you change the source code. This allows for a super fast development and testing cycle which makes it easy to iterate on your graph. There are two different ways that LangGraph rebuilds your image: either by editing the image or completely rebuilding it.

#### Rebuilds from source code changes

If you modified the source code only (no configuration or dependency changes!) then the image does not require a full rebuild, and LangGraph Studio will only update the relevant parts. The UI status in the bottom left will switch from `Online` to `Stopping` temporarily while the image gets edited. The logs will be shown as this process is happening, and after the image has been edited the status will change back to `Online` and you will be able to run your graph with the modified code!


#### Rebuilds from configuration or dependency changes

If you edit your graph configuration file (`langgraph.json`) or the dependencies (either `pyproject.toml` or `requirements.txt`) then the entire image will be rebuilt. This will cause the UI to switch away from the graph view and start showing the logs of the new image building process. This can take a minute or two, and once it is done your updated image will be ready to use!

### Why is my graph taking so long to startup?  (desktop only)

The LangGraph Studio interacts with a local LangGraph API server. To stay aligned with ongoing updates, the LangGraph API requires regular rebuilding. As a result, you may occasionally experience slight delays when starting up your project.

## Why are extra edges showing up in my graph?

If you don't define your conditional edges carefully, you might notice extra edges appearing in your graph. This is because without proper definition, LangGraph Studio assumes the conditional edge could access all other nodes. In order for this to not be the case, you need to be explicit about how you define the nodes the conditional edge routes to. There are two ways you can do this:

### Solution 1: Include a path map

The first way to solve this is to add path maps to your conditional edges. A path map is just a dictionary or array that maps the possible outputs of your router function with the names of the nodes that each output corresponds to. The path map is passed as the third argument to the `add_conditional_edges` function like so:

=== "Python"

    ```python
    graph.add_conditional_edges("node_a", routing_function, {True: "node_b", False: "node_c"})
    ```

=== "Javascript"

    ```ts
    graph.addConditionalEdges("node_a", routingFunction, { foo: "node_b", bar: "node_c" });
    ```

In this case, the routing function returns either True or False, which map to `node_b` and `node_c` respectively.

### Solution 2: Update the typing of the router (Python only)

Instead of passing a path map, you can also be explicit about the typing of your routing function by specifying the nodes it can map to using the `Literal` python definition. Here is an example of how to define a routing function in that way:

```python
def routing_function(state: GraphState) -> Literal["node_b","node_c"]:
    if state['some_condition'] == True:
        return "node_b"
    else:
        return "node_c"
```


## Related

For more information please see the following:

*  [LangGraph Studio how-to guides](../how-tos/index.md#langgraph-studio)
