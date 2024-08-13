"""Adapted from https://github.com/florimondmanca/httpx-sse"""

from contextlib import asynccontextmanager, contextmanager
from typing import Any, AsyncIterator, Iterator, List, Optional, TypedDict

import httpx


class ServerSentEvent(TypedDict):
    event: Optional[str]
    data: Optional[str]
    id: Optional[str]
    retry: Optional[int]


class SSEDecoder:
    def __init__(self) -> None:
        self._event = ""
        self._data: List[str] = []
        self._last_event_id = ""
        self._retry: Optional[int] = None

    def decode(self, line: str) -> Optional[ServerSentEvent]:
        # See: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation  # noqa: E501
        if not line:
            if (
                not self._event
                and not self._data
                and not self._last_event_id
                and self._retry is None
            ):
                return None

            sse = {
                "event": self._event,
                "data": "\n".join(self._data),
                "id": self._last_event_id,
                "retry": self._retry,
            }

            # NOTE: as per the SSE spec, do not reset last_event_id.
            self._event = ""
            self._data = []
            self._retry = None

            return sse

        if line.startswith(":"):
            return None

        fieldname, _, value = line.partition(":")

        if value.startswith(" "):
            value = value[1:]

        if fieldname == "event":
            self._event = value
        elif fieldname == "data":
            self._data.append(value)
        elif fieldname == "id":
            if "\0" in value:
                pass
            else:
                self._last_event_id = value
        elif fieldname == "retry":
            try:
                self._retry = int(value)
            except (TypeError, ValueError):
                pass
        else:
            pass  # Field is ignored.

        return None


class EventSource:
    def __init__(self, response: httpx.Response) -> None:
        self._response = response

    def _check_content_type(self) -> None:
        """Check that the response content type is 'text/event-stream'."""
        self._response.raise_for_status()
        content_type = self._response.headers.get("content-type", "").partition(";")[0]
        if "text/event-stream" not in content_type:
            raise AssertionError(
                "Expected response header Content-Type to contain 'text/event-stream', "
                f"got {content_type!r}"
            )

    @property
    def response(self) -> httpx.Response:
        return self._response

    def iter_sse(self) -> Iterator[ServerSentEvent]:
        self._check_content_type()
        decoder = SSEDecoder()
        for line in self._response.iter_lines():
            line = line.rstrip("\n")
            sse = decoder.decode(line)
            if sse is not None:
                yield sse

    async def aiter_sse(self) -> AsyncIterator[ServerSentEvent]:
        self._check_content_type()
        decoder = SSEDecoder()
        async for line in self._response.aiter_lines():
            line = line.rstrip("\n")
            sse = decoder.decode(line)
            if sse is not None:
                yield sse


@contextmanager
def connect_sse(
    client: httpx.Client, method: str, url: str, **kwargs: Any
) -> Iterator[EventSource]:
    headers = kwargs.pop("headers", {})
    headers["Accept"] = "text/event-stream"
    headers["Cache-Control"] = "no-store"

    with client.stream(method, url, headers=headers, **kwargs) as response:
        yield EventSource(response)


@asynccontextmanager
async def aconnect_sse(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    **kwargs: Any,
) -> AsyncIterator[EventSource]:
    headers = kwargs.pop("headers", {})
    headers["Accept"] = "text/event-stream"
    headers["Cache-Control"] = "no-store"

    async with client.stream(method, url, headers=headers, **kwargs) as response:
        yield EventSource(response)
