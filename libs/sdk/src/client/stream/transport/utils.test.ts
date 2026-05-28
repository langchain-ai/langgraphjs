import { describe, expect, it } from "vitest";
import { toAbsoluteUrl, toWebSocketUrl } from "./utils.js";
import {
  LANGGRAPH_PROXY_API_URL,
  PROXIED_API_URL,
  THREAD_ID,
} from "./test-helpers.js";

describe("toAbsoluteUrl", () => {
  it("preserves apiUrl path prefixes for absolute paths", () => {
    expect(
      toAbsoluteUrl(
        PROXIED_API_URL,
        `/threads/${THREAD_ID}/commands`
      ).toString()
    ).toBe(`${PROXIED_API_URL}/threads/${THREAD_ID}/commands`);
  });

  it("preserves apiUrl path prefixes for stream event paths", () => {
    expect(
      toAbsoluteUrl(
        PROXIED_API_URL,
        `/threads/${THREAD_ID}/stream/events`
      ).toString()
    ).toBe(`${PROXIED_API_URL}/threads/${THREAD_ID}/stream/events`);
  });

  it("matches BaseClient-style concatenation for bare apiUrl hosts", () => {
    expect(
      toAbsoluteUrl(
        "http://localhost:2024",
        `/threads/${THREAD_ID}/commands`
      ).toString()
    ).toBe(`http://localhost:2024/threads/${THREAD_ID}/commands`);
  });

  it("strips a trailing slash from apiUrl before joining", () => {
    expect(
      toAbsoluteUrl(`${LANGGRAPH_PROXY_API_URL}/`, "/threads/search").toString()
    ).toBe(`${LANGGRAPH_PROXY_API_URL}/threads/search`);
  });

  it("aligns with BaseClient.prepareFetchOptions for proxied deployments", () => {
    const apiUrl = PROXIED_API_URL.replace(/\/$/, "");
    const path = `/threads/${THREAD_ID}/commands`;

    expect(toAbsoluteUrl(apiUrl, path).toString()).toBe(
      new URL(`${apiUrl}${path}`).toString()
    );
  });
});

describe("toWebSocketUrl", () => {
  it("preserves path prefixes when converting http(s) to ws(s)", () => {
    expect(
      toWebSocketUrl(
        toAbsoluteUrl(
          PROXIED_API_URL,
          `/threads/${THREAD_ID}/stream/events`
        ).toString()
      )
    ).toBe(
      `ws://localhost:4100/api/chat-langchain/threads/${THREAD_ID}/stream/events`
    );
  });
});
