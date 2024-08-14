import httpx
import uvicorn
import orjson
import os
import asyncio

from concurrent.futures import ThreadPoolExecutor
import threading

from langgraph.pregel.types import StateSnapshot
from langgraph.checkpoint.memory import MemorySaver
from typing import Any, AsyncIterator, Optional, Literal, Union
from langchain_core.runnables.config import RunnableConfig

from server_sent_events import aconnect_sse

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from uuid import uuid4
from langchain_core.runnables import Runnable
from langchain_core.runnables.graph import Graph as DrawableGraph
from langchain_core.runnables.schema import (
    StreamEvent,
    StandardStreamEvent,
    CustomStreamEvent,
)

from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer


GRAPH_SOCKET = "./graph.sock"
CHECKPOINTER_SOCKET = "./checkpointer.sock"


class OrjsonResponse(JSONResponse):
    serializer = JsonPlusSerializer()

    def default(self, obj):
        if hasattr(obj, "_asdict"):
            return obj._asdict()
        return self.serializer._default(obj)

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, default=self.default)


class RemotePregel(Runnable):
    graph_id: str

    async_client: httpx.AsyncClient

    def __init__(self, graph_id: str):
        self.graph_id = graph_id
        self.async_client = httpx.AsyncClient(
            base_url="http://graph",
            transport=httpx.AsyncHTTPTransport(uds=GRAPH_SOCKET),
        )

    async def astream_events(
        self,
        input: Any,
        config: Optional[RunnableConfig] = None,
        *,
        version: Literal["v1", "v2"],
        **kwargs: Any,
    ) -> AsyncIterator[StreamEvent]:
        if version != "v2":
            raise ValueError("Only v2 of astream_events is supported")

        async with aconnect_sse(
            self.async_client,
            "POST",
            f"/{self.graph_id}/streamEvents",
            headers={"Content-Type": "application/json"},
            data=orjson.dumps({"input": input, "config": config}),
        ) as event_source:
            async for sse in event_source.aiter_sse():
                event = orjson.loads(sse["data"])
                if event["event"] == "on_custom_event":
                    yield CustomStreamEvent(**event)
                else:
                    yield StandardStreamEvent(**event)

    def get_graph(
        self,
        config: Optional[RunnableConfig] = None,
        *,
        xray: Union[int, bool] = False,
    ) -> DrawableGraph:
        pass

    async def aget_state(self, config: RunnableConfig) -> StateSnapshot:
        pass

    async def aupdate_state(
        self,
        config: RunnableConfig,
        values: dict[str, Any] | Any,
        as_node: Optional[str] = None,
    ) -> RunnableConfig:
        pass

    async def aget_state_history(
        self,
        config: RunnableConfig,
        *,
        filter: Optional[dict[str, Any]] = None,
        before: Optional[RunnableConfig] = None,
        limit: Optional[int] = None,
    ) -> AsyncIterator[StateSnapshot]:
        raise Exception("Not implemented")

    async def invoke():
        pass


async def run_js_process():
    process = await asyncio.create_subprocess_exec(
        "/Users/duongtat/.yarn/bin/tsx",
        "./ipc/client.mts",
        env={
            "LANGSERVE_GRAPHS": orjson.dumps(
                {"agent": "./test/graphs/agent.mts:graph"}
            ),
            **os.environ,
        },
    )

    await process.wait()


async def run_remote_checkpointer(checkpointer: Any):
    async def get_tuple(request: Request):
        payload = orjson.loads(await request.body())
        res = await checkpointer.aget_tuple(config=payload["config"])

        return OrjsonResponse(res)

    async def list(request: Request):
        payload = orjson.loads(await request.body())
        result = []
        async for item in checkpointer.alist(
            config=payload.get("config"),
            limit=payload.get("limit"),
            before=payload.get("before"),
        ):
            result.append(item)

        return OrjsonResponse(result)

    async def put(request: Request):
        payload = orjson.loads(await request.body())
        res = await checkpointer.aput(
            config=payload["config"],
            checkpoint=payload["checkpoint"],
            metadata=payload["metadata"],
            new_versions={},
        )
        return OrjsonResponse(res)

    remote = Starlette(
        routes=[
            Route("/get_tuple", get_tuple, methods=["POST"]),
            Route("/list", list, methods=["POST"]),
            Route("/put", put, methods=["POST"]),
            Route("/ok", lambda _: OrjsonResponse({"ok": True}), methods=["GET"]),
        ]
    )

    server = uvicorn.Server(uvicorn.Config(remote, uds=CHECKPOINTER_SOCKET))
    await server.serve()


async def wait_until_ready(ready_event: threading.Event):
    graph_client = httpx.AsyncClient(
        base_url="http://graph",
        transport=httpx.AsyncHTTPTransport(uds=GRAPH_SOCKET),
    )

    checkpointer_client = httpx.AsyncClient(
        base_url="http://checkpointer",
        transport=httpx.AsyncHTTPTransport(uds=CHECKPOINTER_SOCKET),
    )

    while True:
        try:
            await graph_client.get("/ok")
            await checkpointer_client.get("/ok")
            break
        except httpx.HTTPError:
            await asyncio.sleep(0.1)

    ready_event.set()


async def start_js_loop(ready_event: threading.Event):
    checkpointer = MemorySaver()
    await asyncio.gather(
        run_remote_checkpointer(checkpointer),
        run_js_process(),
        wait_until_ready(ready_event),
    )


def start_js(ready_event: threading.Event):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(start_js_loop(ready_event))


js_threads = ThreadPoolExecutor()


async def main():
    ready = threading.Event()
    js_threads.submit(start_js, ready)
    ready.wait()

    item = RemotePregel(graph_id="agent")
    async for item in item.astream_events(
        {"input": {"messages": []}},
        version="v2",
        config={"configurable": {"thread_id": uuid4()}},
    ):
        print(item)


if __name__ == "__main__":
    asyncio.run(main())
