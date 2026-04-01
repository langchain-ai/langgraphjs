from __future__ import annotations

import time
from typing import Annotated
from typing_extensions import TypedDict

from langchain_core.messages import AIMessage, HumanMessage, AnyMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages


class State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]


def respond(state: State) -> State:
    last_human = next(
        (message for message in reversed(state["messages"]) if isinstance(message, HumanMessage)),
        None,
    )
    text = last_human.content if isinstance(last_human, HumanMessage) else "(no text content)"

    time.sleep(2.5)
    return {
        "messages": [
            AIMessage(content=f"Python thread stream reply: {text}"),
        ]
    }


graph = (
    StateGraph(State)
    .add_node("respond", respond)
    .add_edge(START, "respond")
    .add_edge("respond", END)
    .compile()
)
