import { Client } from "@langchain/langgraph-sdk";
import { beforeAll, expect, it } from "vitest";
import { gatherIterator, truncate } from "./utils.mjs";
import { SignJWT } from "jose";

const API_URL = "http://localhost:2024";
const config = { configurable: { user_id: "123" } };

const SECRET_KEY = new TextEncoder().encode(
  "09d25e094faa6ca2556c818166b7a9563b93f7099f6f0f4caa6cf63b88e8d3e7",
);
const ALGORITHM = "HS256";

const createJwtClient = async (sub: string, scopes: string[] = []) => {
  const accessToken = await new SignJWT({ sub, scopes })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime("10s")
    .sign(SECRET_KEY);
  return new Client({
    apiUrl: API_URL,
    defaultHeaders: { Authorization: `Bearer ${accessToken}` },
  });
};

beforeAll(() => truncate(API_URL, "all"));

it("unauthenticated user", async () => {
  const client = await createJwtClient("wfh", ["me"]);
  await expect(client.assistants.create({ graphId: "agent" })).rejects.toThrow(
    "HTTP 401",
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
  ).rejects.toThrow("HTTP 404");
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
  ).rejects.toThrow("HTTP 404");
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

  expect(chunks).toMatchObject([
    { event: "error", data: { message: expect.stringContaining("404") } },
  ]);
});

it("store auth", async () => {
  const userA = await createJwtClient("johndoe", ["me", "assistants:write"]);
  const userB = await createJwtClient("alice", ["me", "assistants:write"]);

  await userA.store.deleteItem(["johndoe"], "key_one");
  await userB.store.deleteItem(["alice"], "key_one");

  const threadA = await userA.threads.create();
  const threadB = await userB.threads.create();

  const input1 = { messages: [{ role: "human", content: "test user A" }] };
  const input2 = { messages: [{ role: "human", content: "test user B" }] };

  await Promise.all([
    userA.runs.wait(threadA.thread_id, "agent_simple", {
      input: input1,
      config,
    }),
    userB.runs.wait(threadB.thread_id, "agent_simple", {
      input: input2,
      config,
    }),
  ]);

  // Test store access control
  await expect(userA.store.getItem(["ALL"], "key_one")).rejects.toThrow(
    "HTTP 403",
  );
  await expect(
    userA.store.putItem(["ALL"], "key_one", { foo: "bar" }),
  ).rejects.toThrow("HTTP 403");
  await expect(userA.store.deleteItem(["ALL"], "key_one")).rejects.toThrow(
    "HTTP 403",
  );
  await expect(userA.store.searchItems(["ALL"])).rejects.toThrow("HTTP 403");
  await expect(userA.store.listNamespaces({ prefix: ["ALL"] })).rejects.toThrow(
    "HTTP 403",
  );

  // Test owner can access their own store
  expect(await userA.store.getItem(["johndoe"], "key_one")).toMatchObject({
    value: { text: "test user A" },
  });

  expect(await userA.store.searchItems(["johndoe"])).toMatchObject({
    items: [{ key: "key_one", value: { text: "test user A" } }],
  });

  expect(
    await userA.store.listNamespaces({ prefix: ["johndoe"] }),
  ).toMatchObject({ namespaces: [["johndoe"]] });

  // Test other user can access their own store
  expect(await userB.store.getItem(["alice"], "key_one")).toMatchObject({
    value: { text: "test user B" },
  });
  expect(await userB.store.searchItems(["alice"])).toMatchObject({
    items: [{ key: "key_one", value: { text: "test user B" } }],
  });
  expect(await userB.store.listNamespaces({ prefix: ["alice"] })).toMatchObject(
    { namespaces: [["alice"]] },
  );
});

it("run cancellation", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = { messages: [{ role: "human", content: "test" }] };
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input,
    config,
  });

  // Other user can't cancel the run
  await expect(
    otherUser.runs.cancel(thread.thread_id, run.run_id),
  ).rejects.toThrow("HTTP 404");

  // Owner can cancel their own run
  await owner.runs.cancel(thread.thread_id, run.run_id);
});

it("get assistant ownership", async () => {
  const owner = await createJwtClient("johndoe", ["assistants:write"]);
  const otherUser = await createJwtClient("alice", ["assistants:write"]);

  const assistant = await owner.assistants.create({ graphId: "agent" });

  // Owner can get the assistant
  const fetched = await owner.assistants.get(assistant.assistant_id);
  expect(fetched.assistant_id).toBe(assistant.assistant_id);

  // Another user cannot get this assistant
  await expect(
    otherUser.assistants.get(assistant.assistant_id),
  ).rejects.toThrow("HTTP 404");

  // Test invalid assistant IDs
  const nonexistantUuid = crypto.randomUUID();
  await expect(owner.assistants.get(nonexistantUuid)).rejects.toThrow(
    "HTTP 404",
  );
});

it("get assistant graph", async () => {
  const owner = await createJwtClient("johndoe", ["assistants:write"]);
  const otherUser = await createJwtClient("alice", ["assistants:write"]);

  const assistant = await owner.assistants.create({ graphId: "agent" });

  // Owner can get the graph
  const graph = await owner.assistants.getGraph(assistant.assistant_id);
  expect(graph).toBeInstanceOf(Object);
  expect(graph).toHaveProperty("nodes");
  expect(graph).toHaveProperty("edges");

  // Another user can't access the graph
  await expect(
    otherUser.assistants.getGraph(assistant.assistant_id),
  ).rejects.toThrow("HTTP 404");
});

it("thread state operations", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = { messages: [{ type: "human", content: "test" }] };
  const run = await owner.runs.create(thread.thread_id, "agent_simple", {
    input,
    config,
  });
  expect(run.run_id).toBeDefined();
  await owner.runs.join(thread.thread_id, run.run_id);

  // Owner can get and update state
  const state = await owner.threads.getState(thread.thread_id);
  expect(state.values).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({ type: "human", content: "test" }),
    ]),
  });

  await owner.threads.updateState(thread.thread_id, { values: { sleep: 432 } });
  const updatedState = await owner.threads.getState(thread.thread_id);
  expect(updatedState.values).toMatchObject({ sleep: 432 });

  // Another user cannot access or modify state
  await expect(otherUser.threads.getState(thread.thread_id)).rejects.toThrow(
    "HTTP 404",
  );
  await expect(
    otherUser.threads.updateState(thread.thread_id, { values: { sleep: 432 } }),
  ).rejects.toThrow("HTTP 404");
});

it("run operations", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = { messages: [{ role: "human", content: "test" }] };
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input,
    config,
    afterSeconds: 100,
  });
  expect(run.run_id).toBeDefined();

  // Owner can list runs
  const runs = await owner.runs.list(thread.thread_id);
  expect(runs).toMatchObject(
    expect.arrayContaining([expect.objectContaining({ run_id: run.run_id })]),
  );

  // Owner can get specific run
  const runInfo = await owner.runs.get(thread.thread_id, run.run_id);
  expect(runInfo).toMatchObject({ run_id: run.run_id });

  // Another user cannot access runs, cancel or delete a run not owned by them
  await expect(otherUser.runs.list(thread.thread_id)).rejects.toThrow(
    "HTTP 404",
  );
  await expect(
    otherUser.runs.get(thread.thread_id, run.run_id),
  ).rejects.toThrow("HTTP 404");

  await expect(
    otherUser.runs.cancel(thread.thread_id, run.run_id, true),
  ).rejects.toThrow("HTTP 404");

  await expect(
    otherUser.runs.delete(thread.thread_id, run.run_id),
  ).rejects.toThrow("HTTP 404");

  // Owner can cancel run
  await owner.runs.cancel(thread.thread_id, run.run_id, true);

  // Owner can delete run
  await owner.runs.delete(thread.thread_id, run.run_id);
  await expect(owner.runs.get(thread.thread_id, run.run_id)).rejects.toThrow(
    "HTTP 404",
  );
});

it("create run in other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = {
    messages: [{ role: "human", content: "Unauthorized attempt" }],
  };

  await expect(
    otherUser.runs.create(thread.thread_id, "agent", { input, config }),
  ).rejects.toThrow("HTTP 404");
});

it("list runs other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = { messages: [{ role: "human", content: "Hello" }] };
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input,
    config,
  });

  // Owner can list runs
  const ownerRuns = await owner.runs.list(thread.thread_id);
  expect(ownerRuns.some((r) => r.run_id === run.run_id)).toBe(true);

  // Other user cannot list runs
  await expect(otherUser.runs.list(thread.thread_id)).rejects.toThrow(
    "HTTP 404",
  );
});

it("get run other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input: { messages: [{ role: "human", content: "Check run" }] },
    config,
  });

  // Other user attempts to get the run
  await expect(
    otherUser.runs.get(thread.thread_id, run.run_id),
  ).rejects.toThrow("HTTP 404");
});

it("join run other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input: { messages: [{ role: "human", content: "Join?" }] },
    config,
  });

  // Other user tries to join the run
  await expect(
    otherUser.runs.join(thread.thread_id, run.run_id),
  ).rejects.toThrow("HTTP 404");
});

it("wait run other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const input = { messages: [{ role: "human", content: "Waiting test" }] };
  await owner.runs.create(thread.thread_id, "agent", { input, config });

  // Other user tries to wait on run result
  await expect(
    otherUser.runs.wait(thread.thread_id, "agent", { input, config }),
  ).rejects.toThrow("HTTP 404");
});

it("stream run other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input: { messages: [{ role: "human", content: "Stream me" }] },
    config,
  });

  // Other user tries to join_stream
  const chunks = await gatherIterator(
    otherUser.runs.joinStream(thread.thread_id, run.run_id),
  );
  expect(chunks).toHaveLength(1);
  expect(chunks).toMatchObject([
    { event: "error", data: { message: expect.stringContaining("404") } },
  ]);
});

it("cancel run other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input: { messages: [{ role: "human", content: "Cancel test" }] },
    config,
    afterSeconds: 100,
  });

  await expect(
    otherUser.runs.cancel(thread.thread_id, run.run_id),
  ).rejects.toThrow("HTTP 404");

  await owner.runs.cancel(thread.thread_id, run.run_id);
});

it("delete run other user thread", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const run = await owner.runs.create(thread.thread_id, "agent", {
    input: { messages: [{ role: "human", content: "Delete me" }] },
    config,
    afterSeconds: 100,
  });

  await expect(
    otherUser.runs.delete(thread.thread_id, run.run_id),
  ).rejects.toThrow("HTTP 404");

  await owner.runs.cancel(thread.thread_id, run.run_id);
});

it("update thread state other user", async () => {
  const owner = await createJwtClient("johndoe", ["me"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  const thread = await owner.threads.create();
  const newState = { values: { some: "value" } };

  // Other user tries to update state
  await expect(
    otherUser.threads.updateState(thread.thread_id, newState),
  ).rejects.toThrow("HTTP 404");
});

it("get checkpoint other user", async () => {
  const owner = await createJwtClient("johndoe", ["me", "assistants:write"]);
  const otherUser = await createJwtClient("alice", ["me"]);

  await owner.assistants.create({ graphId: "agent" });
  const thread = await owner.threads.create();
  const input = { messages: [{ role: "human", content: "Checkpoint test" }] };
  await owner.runs.wait(thread.thread_id, "agent", { input, config });

  // Get history to find a checkpoint
  const history = await owner.threads.getHistory(thread.thread_id);
  if (history.length === 0) {
    return; // Skip if no checkpoints
  }

  const checkpointId = history[history.length - 1].checkpoint?.checkpoint_id;
  if (!checkpointId) {
    return; // Skip if no checkpoint ID
  }

  await expect(
    otherUser.threads.getState(thread.thread_id, checkpointId),
  ).rejects.toThrow("HTTP 404");
});

it("assistant version leakage", async () => {
  const owner = await createJwtClient("johndoe", ["assistants:write"]);
  const otherUser = await createJwtClient("alice", ["assistants:write"]);

  const assistant = await owner.assistants.create({ graphId: "agent" });
  const someId = crypto.randomUUID();
  const result = await owner.assistants.update(assistant.assistant_id, {
    metadata: { foo: someId },
  });
  expect(result.metadata?.foo).toBe(someId);

  await expect(
    otherUser.assistants.getVersions(assistant.assistant_id),
  ).rejects.toThrow("HTTP 404");
  await expect(
    otherUser.assistants.setLatest(assistant.assistant_id, 1),
  ).rejects.toThrow("HTTP 404");
});

it("assistant set latest", async () => {
  const owner = await createJwtClient("johndoe", ["assistants:write"]);
  const otherUser = await createJwtClient("alice", ["assistants:write"]);

  const assistant = await owner.assistants.create({ graphId: "agent" });
  const updated = await owner.assistants.update(assistant.assistant_id, {
    metadata: { foo: "bar" },
  });
  expect(updated.metadata?.foo).toBe("bar");

  await expect(
    otherUser.assistants.setLatest(assistant.assistant_id, 1),
  ).rejects.toThrow("HTTP 404");

  const result = await owner.assistants.setLatest(assistant.assistant_id, 1);
  expect(result.assistant_id).toBe(assistant.assistant_id);
  expect(result.version).toBe(1);
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
    "HTTP 409",
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
