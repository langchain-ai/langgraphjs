"""Graphs for ../stream.test.tsx, which asserts on their exact replies."""

import json
from typing import Annotated, Any
from uuid import uuid4

from deepagents import create_deep_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, RemoveMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.config import get_stream_writer
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.graph.message import push_message
from langgraph.types import Command, interrupt

# Streams "H", "e", "y" slowly enough for the stop test to click mid-stream.
model = FakeListChatModel(responses=["Hey"], sleep=0.3)


async def call_model(state: MessagesState) -> dict:
    get_stream_writer()("Custom events")
    return {"messages": [await model.ainvoke(state["messages"])]}


agent = (
    StateGraph(MessagesState)
    .add_node("agent", call_model)
    .add_edge(START, "agent")
    .compile()
)

parent_agent = (
    StateGraph(MessagesState)
    .add_node("child", agent)
    .add_edge(START, "child")
    .compile()
)


def ask(state: MessagesState) -> dict:
    return {"messages": [AIMessage(f"Hey: {interrupt({'nodeName': 'agent'})}")]}


interrupt_agent = (
    StateGraph(MessagesState)
    .add_sequence(
        [
            (
                "beforeInterrupt",
                lambda state: {"messages": [AIMessage("Before interrupt")]},
            ),
            ("agent", ask),
            (
                "afterInterrupt",
                lambda state: {"messages": [AIMessage("After interrupt")]},
            ),
        ]
    )
    .add_edge(START, "beforeInterrupt")
    .compile()
)


def replace_ai_messages(state: MessagesState) -> dict:
    messages = [RemoveMessage(id=m.id) for m in state["messages"] if m.type == "ai"]
    messages.append(AIMessage("Step 2: To Keep", id=str(uuid4())))
    for message in messages:
        push_message(message, state_key=None)
    return {"messages": messages}


remove_message_agent = (
    StateGraph(MessagesState)
    .add_sequence(
        [
            ("step1", lambda state: {"messages": [AIMessage("Step 1: To Remove")]}),
            ("step2", replace_ai_messages),
            ("step3", lambda state: {"messages": [AIMessage("Step 3: To Keep")]}),
        ]
    )
    .add_edge(START, "step1")
    .compile()
)


def fail(state: MessagesState) -> dict:
    raise ValueError("Intentional error for testing")


error_agent = (
    StateGraph(MessagesState).add_node("agent", fail).add_edge(START, "agent").compile()
)


class ScriptedModel(BaseChatModel):
    """Makes `calls`, then answers `reply` with the tool outputs it got.

    It decides from the messages, not from a call count, so a retried test gets
    the same answers.
    """

    calls: list[dict]
    reply: str

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        outputs = [m.text for m in messages if isinstance(m, ToolMessage)]
        if outputs:
            message = AIMessage(f"{self.reply} Tool output: {'; '.join(outputs)}")
        else:
            message = AIMessage("", tool_calls=self.calls)
        return ChatResult(generations=[ChatGeneration(message=message)])


@tool
def search_web(query: str) -> str:
    """Search the web for information on a topic."""
    results = [
        {"title": f"Result for: {query}", "url": "https://example.com/1"},
        {"title": f"More on: {query}", "url": "https://example.com/2"},
    ]
    return json.dumps({"status": "success", "query": query, "results": results})


@tool
def query_database(
    table: str, tool_call_id: Annotated[str, InjectedToolCallId]
) -> Command:
    """Query a database table with optional filters."""
    records = [
        {"id": 1, "name": "Record A", "value": 42},
        {"id": 2, "name": "Record B", "value": 87},
    ]
    content = json.dumps(
        {"status": "success", "table": table, "records": records, "count": 2}
    )
    return Command(
        update={
            "messages": [
                ToolMessage(content, tool_call_id=tool_call_id, name="query_database")
            ]
        }
    )


def call(name: str, call_id: str, **args: Any) -> dict:
    return {"name": name, "args": args, "id": call_id}


deep_agent = create_deep_agent(
    model=ScriptedModel(
        calls=[
            call(
                "task",
                "task-1",
                description="Search the web for test research query",
                subagent_type="researcher",
            ),
            call(
                "task",
                "task-2",
                description="Query the database for test data",
                subagent_type="data-analyst",
            ),
        ],
        reply="Both agents completed their tasks successfully.",
    ),
    subagents=[
        {
            "name": "researcher",
            "description": "Research specialist that searches the web for information.",
            "system_prompt": "You are a research specialist.",
            "tools": [search_web],
            "model": ScriptedModel(
                calls=[call("search_web", "search-1", query="test research query")],
                reply="Research completed: found relevant results.",
            ),
        },
        {
            "name": "data-analyst",
            "description": "Data analysis expert that queries databases for insights.",
            "system_prompt": "You are a data analysis expert.",
            "tools": [query_database],
            "model": ScriptedModel(
                calls=[call("query_database", "query-1", table="test_data")],
                reply="Analysis completed: found 2 records.",
            ),
        },
    ],
    system_prompt="You are an AI coordinator that delegates tasks.",
)
