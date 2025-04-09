import { Client } from "@langchain/langgraph-sdk";
import { beforeAll, expect, it } from "vitest";
import { gatherIterator, truncate } from "./utils.mjs";
import { sign } from "hono/jwt";

const API_URL = "http://localhost:2024";
const config = { configurable: { user_id: "123" } };

const SECRET_KEY =
  "09d25e094faa6ca2556c818166b7a9563b93f7099f6f0f4caa6cf63b88e8d3e7";
const ALGORITHM = "HS256";

const createJwtClient = async (sub: string, scopes: string[] = []) => {
  const accessToken = await sign({ sub, scopes }, SECRET_KEY, ALGORITHM);
  return new Client({
    apiUrl: API_URL,
    defaultHeaders: { Authorization: `Bearer ${accessToken}` },
  });
};

beforeAll(() => truncate(API_URL, "all"));

it("unauthenticated user", async () => {
  const client = await createJwtClient("wfh", ["me"]);
  await expect(client.assistants.create({ graphId: "agent" })).rejects.toThrow(
    /HTTP (401|403)/,
  );
});

it("create assistant with forbidden scopes", async () => {
  let user = await createJwtClient("johndoe");
  await expect(user.assistants.create({ graphId: "agent" })).rejects.toThrow(
    "HTTP 403",
  );

  user = await createJwtClient("johndoe", ["foo"]);
  await expect(user.assistants.create({ graphId: "agent" })).rejects.toThrow(
    "HTTP 403",
  );

  user = await createJwtClient("johndoe", ["assistants:write"]);
  await user.assistants.create({ graphId: "agent" });

  const fetched = await user.assistants.search({ graphId: "agent" });
  expect(fetched).toHaveLength(1);
  expect(fetched).toMatchObject([{ metadata: { owner: "johndoe" } }]);
});

it("get thread history from unauthorized user", async () => {
  const input = { messages: [{ role: "human", content: "foo" }] };
  const user1 = await createJwtClient("johndoe", ["me", "assistants:write"]);

  await user1.assistants.create({ graphId: "agent" });
  let thread = await user1.threads.create();
  let history = await user1.threads.getHistory(thread.thread_id);
  expect(history).toEqual([]);

  await user1.runs.wait(thread.thread_id, "agent", { input, config });
  history = await user1.threads.getHistory(thread.thread_id);
  expect(history).toHaveLength(5);

  const user2 = await createJwtClient("alice", ["me"]);
  await expect(
    user2.runs.wait(thread.thread_id, "agent", { input, config }),
  ).rejects.toThrow("HTTP 403");
});

it("add run to unauthorized thread", async () => {
  const user1 = await createJwtClient("johndoe", ["me"]);
  const thread = await user1.threads.create();

  const input = { messages: [{ role: "human", content: "foo" }] };
  const history = await user1.threads.getHistory(thread.thread_id);
  expect(history).toEqual([]);

  const user2 = await createJwtClient("alice", ["me"]);
  await expect(
    user2.runs.wait(thread.thread_id, "agent", { input, config }),
  ).rejects.toThrow("HTTP 403");
});

it("asssistant access control", async () => {
  const owner = await createJwtClient("johndoe", ["assistants:write"]);
  const otherUser = await createJwtClient("alice", ["assistants:write"]);

  const assistant = await owner.assistants.create({ graphId: "agent" });

  // Other user can't update the assistant
  await expect(
    otherUser.assistants.update(assistant.assistant_id, {
      metadata: { foo: "bar" },
    }),
  ).rejects.toThrow("HTTP 404");

  // Other user can't delete the assistant
  await expect(
    otherUser.assistants.delete(assistant.assistant_id),
  ).rejects.toThrow("HTTP 404");
});

it("thread operations auth", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();

  // Other user can't update thread
  await expect(
    otherUser.threads.update(thread.thread_id, { metadata: { foo: "bar" } }),
  ).rejects.toThrow("HTTP 404");

  // Other user can't delete thread
  await expect(otherUser.threads.delete(thread.thread_id)).rejects.toThrow(
    "HTTP 404",
  );
});

it("run streaming auth", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = { messages: [{ role: "human", content: "foo" }] };

  const run = await owner.runs.create(thread.thread_id, "agent", {
    input,
    config,
  });

  const chunks = await gatherIterator(
    otherUser.runs.joinStream(thread.thread_id, run.run_id),
  );

  expect(chunks).toEqual([{ event: "error", data: "Thread not found" }]);
});

it("assistant search filtering", async () => {
  const user1 = await createJwtClient("johndoe", ["assistants:write"]);
  const user2 = await createJwtClient("alice", ["assistants:write"]);

  const assistant1 = await user1.assistants.create({ graphId: "agent" });
  const assistant2 = await user2.assistants.create({ graphId: "agent" });

  // each user should only see their own assistants
  const results1 = await user1.assistants.search();
  expect(results1).toContainEqual(
    expect.objectContaining({ assistant_id: assistant1.assistant_id }),
  );
  expect(results1).not.toContainEqual(
    expect.objectContaining({ assistant_id: assistant2.assistant_id }),
  );

  const results2 = await user2.assistants.search();
  expect(results2).toContainEqual(
    expect.objectContaining({ assistant_id: assistant2.assistant_id }),
  );
  expect(results2).not.toContainEqual(
    expect.objectContaining({ assistant_id: assistant1.assistant_id }),
  );
});

it("thread copy authorization", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();

  // Other user can't copy the thread
  await expect(otherUser.threads.copy(thread.thread_id)).rejects.toThrow(
    "HTTP 404",
  );

  // Owner can copy the thread
  const copiedThread = await owner.threads.copy(thread.thread_id);
  expect(copiedThread).not.toBeNull();
});

it("thread history authorization", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = { messages: [{ role: "human", content: "foo" }] };

  await owner.runs.wait(thread.thread_id, "agent", { input, config });
  const history = await owner.threads.getHistory(thread.thread_id);
  expect(history).toHaveLength(5);

  await expect(otherUser.threads.getHistory(thread.thread_id)).rejects.toThrow(
    "HTTP 404",
  );
});

it("test stateless runs", async () => {
  const owner = await createJwtClient("johndoe", ["me", "assistants:write"]);
  const assistant = await owner.assistants.create({ graphId: "agent" });
  const input = {
    messages: [{ role: "human", content: "stateless run test" }],
  };

  const values = await owner.runs.wait(null, assistant.assistant_id, {
    input,
    config,
  });

  expect(values).not.toBeNull();
  const chunks = await gatherIterator(
    owner.runs.stream(null, assistant.assistant_id, { input, config }),
  );

  expect(chunks.find((i) => i.event === "error")).not.toBeDefined();
});
