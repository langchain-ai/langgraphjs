"""Twins of the graphs in ../../fixtures, so the scenarios' expected replies hold on this server."""

import asyncio
import json
import re
from typing import Annotated, Any, TypedDict
from uuid import uuid4

from deepagents import create_deep_agent
from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    ToolMessage,
    get_notification_metadata,
)
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.config import get_stream_writer
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.graph.message import push_message
from langgraph.types import Command, Send, interrupt

WORKERS = 6


class TextModel(FakeListChatModel):
    """Streams its replies a character at a time, in turn."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> "TextModel":
        return self


class ScriptedModel(BaseChatModel):
    """Makes `calls` for a new turn, and gives `answer` once the tools answered.

    A task notification the agent adds doesn't start a new turn.
    """

    calls: AIMessage
    answer: AIMessage

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        last = next(m for m in reversed(messages) if get_notification_metadata(m) is None)
        turn = self.answer if last.type in ("tool", "ai") else self.calls
        return ChatResult(generations=[ChatGeneration(message=turn.model_copy(deep=True))])


def call(call_id: str, name: str, **args: Any) -> dict:
    return {"name": name, "args": args, "id": call_id, "type": "tool_call"}


def tool_calling_model(call_id: str, name: str, args: dict, answer: str) -> ScriptedModel:
    return ScriptedModel(
        calls=AIMessage("", id=f"{call_id}-message", tool_calls=[call(call_id, name, **args)]),
        answer=AIMessage(answer, id=f"{call_id}-final"),
    )


def task(call_id: str, description: str, subagent_type: str) -> dict:
    return call(call_id, "task", description=description, subagent_type=subagent_type)


def single_node(node: Any, state: type = MessagesState) -> Any:
    return StateGraph(state).add_node("agent", node).add_edge(START, "agent").compile()


plan_model = TextModel(responses=["Plan accepted."], sleep=0.015)


async def plan(state: MessagesState) -> dict:
    return {"messages": [await plan_model.ainvoke(state["messages"])]}


stategraph_text = single_node(plan)


async def answer_after_wait(state: MessagesState) -> dict:
    asked = re.search(r"wait (\d+)", state["messages"][-1].text)
    await asyncio.sleep(int(asked[1]) / 1000 if asked else 0.4)
    return {"messages": [AIMessage("Done.")]}


slow_graph = single_node(answer_after_wait)


def fail_unless_recover(state: MessagesState) -> dict:
    if state["messages"][-1].text != "recover":
        raise ValueError("Intentional error for testing")
    return {"messages": [AIMessage("Recovered.")]}


error_graph = single_node(fail_unless_recover)


def write_custom(state: MessagesState) -> dict:
    write = get_stream_writer()
    write({"stage": "thinking"})
    write({"name": "status", "payload": {"label": "answering"}})
    write({"stage": "done"})
    return {"messages": [AIMessage("Custom channel reply")]}


custom_channel_graph = single_node(write_custom)


class StatefulState(MessagesState):
    status: str


async def finish(state: StatefulState) -> dict:
    await asyncio.sleep(0.4)
    return {"messages": [AIMessage("Done.")], "status": "final"}


stateful_values_graph = single_node(finish, StatefulState)


def replace_ai_messages(state: MessagesState) -> dict:
    messages = [RemoveMessage(id=m.id) for m in state["messages"] if m.type == "ai"]
    messages.append(AIMessage("Step 2: To Keep", id=str(uuid4())))
    for message in messages:
        push_message(message, state_key=None)
    return {"messages": messages}


remove_message_graph = (
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


class ReviewState(TypedDict):
    request: str
    decision: dict | None
    completed: bool


def as_decision(value: Any) -> dict:
    return value if isinstance(value, dict) else {"value": value}


async def review_then_work(state: ReviewState) -> dict:
    decision = interrupt({"prompt": "Approve the outbound action?", "request": state["request"]})
    await asyncio.sleep(0.4)
    return {"decision": as_decision(decision), "completed": True}


def review_graph(node: Any, state: type = ReviewState) -> Any:
    return StateGraph(state).add_node("review", node).add_edge(START, "review").compile()


interrupt_graph = review_graph(review_then_work)


class OnceState(TypedDict):
    request: str
    decision: dict | None
    completedTurns: int


def review_once(state: OnceState) -> dict:
    turns = state.get("completedTurns", 0) + 1
    if state.get("decision") is not None:
        return {"completedTurns": turns}
    decision = interrupt({"prompt": "Approve the outbound action?", "request": state["request"]})
    return {"decision": as_decision(decision), "completedTurns": turns}


interrupt_once_graph = review_graph(review_once, OnceState)


def review_nested(state: ReviewState) -> dict:
    decision = interrupt({"prompt": "Approve nested subgraph action?", "request": state["request"]})
    return {"decision": as_decision(decision), "completed": True}


nested_interrupt_graph = (
    StateGraph(ReviewState)
    .add_node(
        "child",
        StateGraph(ReviewState)
        .add_node("inner", review_graph(review_nested))
        .add_edge(START, "inner")
        .compile(),
    )
    .add_edge(START, "child")
    .compile()
)


class MultiState(TypedDict):
    prompts: list[str]
    decisions: Annotated[dict, lambda old, new: {**old, **new}]
    completed: bool


def review_one(state: dict) -> dict:
    prompt = state["prompt"]
    decision = interrupt({"prompt": f"Approve action {prompt}?", "action": prompt})
    return {"decisions": {prompt: decision}}


multi_interrupt_graph = (
    StateGraph(MultiState)
    .add_node("review", review_one)
    .add_node(
        "aggregate",
        lambda state: {"completed": all(p in state["decisions"] for p in state["prompts"])},
    )
    .add_conditional_edges(
        START, lambda state: [Send("review", {"prompt": p}) for p in state["prompts"]], ["review"]
    )
    .add_edge("review", "aggregate")
    .compile()
)


@tool
async def review_action(toolArg: str) -> str:
    """Perform a sensitive action that requires human approval."""
    card = {"kind": "tool_validation", "action": toolArg, "buttons": ["approve", "reject"]}
    response = interrupt(
        {
            "type": "ai",
            "content": f'Please review the "{toolArg}" action.',
            "response_metadata": {"cards": card},
        }
    )
    if not (response is True or (isinstance(response, dict) and response.get("approved") is True)):
        return "User has rejected the toolcall"
    await asyncio.sleep(1)
    return f'Executed "{toolArg}".'


interrupt_card_graph = create_agent(
    model=tool_calling_model("call-review-1", "review_action", {"toolArg": "delete_db"}, "Done."),
    tools=[review_action],
    system_prompt="You are a deterministic approval agent for protocol testing.",
)


@tool
async def get_weather(city: str) -> str:
    """Get weather for a city."""
    await asyncio.sleep(0.2)
    return json.dumps({"city": city, "temp_f": 64, "condition": "Foggy"})


weather_agent = create_agent(
    model=tool_calling_model(
        "call-weather-1",
        "get_weather",
        {"city": "San Francisco"},
        "It's 64F and foggy in San Francisco.",
    ),
    tools=[get_weather],
    system_prompt="You are a deterministic weather agent for protocol testing.",
)


@tool
async def search_web(query: str) -> str:
    """Search the web for information on a topic."""
    await asyncio.sleep(0.6)
    results = [
        {"title": f"Result for: {query}", "url": "https://example.com/1"},
        {"title": f"More on: {query}", "url": "https://example.com/2"},
    ]
    return json.dumps({"status": "success", "query": query, "results": results})


@tool
def query_database(table: str, tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Query a database table with optional filters."""
    records = [
        {"id": 1, "name": "Record A", "value": 42},
        {"id": 2, "name": "Record B", "value": 87},
    ]
    content = json.dumps({"status": "success", "table": table, "records": records, "count": 2})
    return Command(
        update={"messages": [ToolMessage(content, tool_call_id=tool_call_id, name="query_database")]}
    )


deep_agent = create_deep_agent(
    model=ScriptedModel(
        calls=AIMessage(
            "",
            id="deep-orchestrator-tool-call",
            tool_calls=[
                task("task-1", "Search the web for protocol risks", "researcher"),
                task("task-2", "Inspect the sample dataset", "data-analyst"),
            ],
        ),
        answer=AIMessage(
            "Both subagents completed their tasks successfully.", id="deep-orchestrator-final"
        ),
    ),
    subagents=[
        {
            "name": "researcher",
            "description": "Research specialist that searches the web for information.",
            "system_prompt": "You are a research specialist.",
            "tools": [search_web],
            "model": tool_calling_model(
                "search-1",
                "search_web",
                {"query": "protocol risks"},
                "Research completed: reconnect and lifecycle handling need coverage.",
            ),
        },
        {
            "name": "data-analyst",
            "description": "Data analysis expert that queries databases for insights.",
            "system_prompt": "You are a data analysis expert.",
            "tools": [query_database],
            "model": tool_calling_model(
                "query-1",
                "query_database",
                {"table": "sample_data"},
                "Analysis completed: found 2 sample records.",
            ),
        },
    ],
    system_prompt="You are an AI coordinator that delegates tasks.",
)


@tool
def request_approval() -> str:
    """Request human approval before proceeding."""
    decision = interrupt({"prompt": "Approve subagent tool action?"})
    return json.dumps(decision if decision is not None else {"approved": True})


deep_agent_interrupt = create_deep_agent(
    model=ScriptedModel(
        calls=AIMessage(
            "",
            id="deep-interrupt-orchestrator",
            tool_calls=[task("task-approve-1", "Request approval for the pending change", "approver")],
        ),
        answer=AIMessage("Subagent approval completed.", id="deep-interrupt-final"),
    ),
    subagents=[
        {
            "name": "approver",
            "description": "Requests human approval before acting.",
            "system_prompt": "You must request approval before proceeding.",
            "tools": [request_approval],
            "model": ScriptedModel(
                calls=AIMessage(
                    "", id="approver-call", tool_calls=[call("approval-1", "request_approval")]
                ),
                answer=AIMessage("Approval recorded.", id="approver-done"),
            ),
        }
    ],
    system_prompt="Delegate approval work to the approver subagent.",
)


def inner_subgraph(reply: str, started: str, finished: str | None = None) -> Any:
    model = TextModel(responses=[reply])

    async def inner(state: MessagesState) -> dict:
        write = get_stream_writer()
        write({"type": "progress", "label": started})
        response = await model.ainvoke(state["messages"])
        if finished:
            write({"type": "progress", "label": finished})
        return {"messages": [response]}

    return StateGraph(MessagesState).add_node("inner", inner).add_edge(START, "inner").compile()


subgraph_graph = (
    StateGraph(MessagesState)
    .add_node("child", inner_subgraph("Reply from child", "child-started", "child-finished"))
    .add_edge(START, "child")
    .compile()
)

research_subgraph = inner_subgraph("Subgraph reply", "research-started", "research-finished")


async def research(state: MessagesState) -> dict:
    result = await research_subgraph.ainvoke({"messages": state["messages"]})
    content = result["messages"][-1].content
    return {"messages": [AIMessage(content if isinstance(content, str) else "Research done")]}


embedded_subgraph_graph = (
    StateGraph(MessagesState)
    .add_sequence(
        [
            ("research", research),
            ("summarize", lambda state: {"messages": [AIMessage("Summary line")]}),
        ]
    )
    .add_edge(START, "research")
    .compile()
)

parallel_subgraph = (
    StateGraph(MessagesState)
    .add_node("worker", inner_subgraph("Subgraph reply", "worker-started"))
    .add_conditional_edges(
        START,
        lambda state: [
            Send("worker", {"messages": [HumanMessage(f"Subtask {i}")]})
            for i in range(1, WORKERS + 1)
        ],
        ["worker"],
    )
    .compile()
)

parallel_fanout = create_deep_agent(
    model=ScriptedModel(
        calls=AIMessage(
            "",
            id="fanout-orchestrator",
            tool_calls=[
                task(f"task-{i}", f"Worker worker-{i:03d} covering topic {i}", "worker")
                for i in range(1, WORKERS + 1)
            ],
        ),
        answer=AIMessage("All workers completed.", id="fanout-final"),
    ),
    subagents=[
        {
            "name": "worker",
            "description": "A worker that completes a single delegated subtask.",
            "system_prompt": "You are a worker. Complete the task and report back.",
            "tools": [],
            "model": TextModel(responses=[f"Worker {i} done." for i in range(1, WORKERS + 1)]),
        }
    ],
    system_prompt="You are a coordinator that fans out work to many workers.",
)

researcher_model = TextModel(responses=["Research finished."], sleep=0.08)


async def research_in_background(state: MessagesState) -> dict:
    return {"messages": [await researcher_model.ainvoke(state["messages"])]}


async_researcher = single_node(research_in_background)


class LeadModel(BaseChatModel):
    """Starts a background task for the user's first message and sends it each later one.

    The agent adds task notifications as human messages, which it skips.
    """

    @property
    def _llm_type(self) -> str:
        return "lead"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "LeadModel":
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        asked = max(
            i
            for i, m in enumerate(messages)
            if m.type == "human" and get_notification_metadata(m) is None
        )
        ask = messages[asked].text
        launched = [m.text for m in messages[:asked] if m.type == "tool" and "task_id: " in m.text]
        if any(m.type == "tool" for m in messages[asked:]):
            message = AIMessage("The researcher is on it.")
        elif launched:
            task_id = launched[0].split("task_id: ")[1]
            message = AIMessage(
                "", tool_calls=[call("update-1", "update_async_task", task_id=task_id, message=ask)]
            )
        else:
            message = AIMessage(
                "",
                tool_calls=[
                    call("start-1", "start_async_task", description=ask, subagent_type="researcher")
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=message)])


async_subagent = create_deep_agent(
    model=LeadModel(),
    subagents=[
        {
            "name": "researcher",
            "description": "Researches a topic in the background.",
            "graph_id": "async_researcher",
        }
    ],
    system_prompt="You delegate research to a background subagent.",
)

reviewer_model = TextModel(responses=["Review finished."], sleep=0.08)


async def review_once_approved(state: MessagesState) -> dict:
    interrupt({"prompt": "Approve the review?"})
    return {"messages": [await reviewer_model.ainvoke(state["messages"])]}


async_reviewer = single_node(review_once_approved)

five_workers = create_deep_agent(
    model=ScriptedModel(
        calls=AIMessage(
            "",
            id="five-workers-orchestrator",
            tool_calls=[
                call(
                    "review-1",
                    "start_async_task",
                    description="Review the plan",
                    subagent_type="reviewer",
                ),
                *(task(f"part-{i}", f"Check part {i}", "worker") for i in range(1, 6)),
            ],
        ),
        answer=AIMessage("All parts checked.", id="five-workers-final"),
    ),
    subagents=[
        {
            "name": "worker",
            "description": "Checks one part of a plan.",
            "system_prompt": "You check one part of a plan.",
            "tools": [],
            "model": TextModel(responses=["Part checked: every case passes."], sleep=1.0),
        },
        {
            "name": "reviewer",
            "description": "Reviews a plan in the background once approved.",
            "graph_id": "async_reviewer",
        },
    ],
    system_prompt="You split a plan into parts for workers and start a background review.",
)
