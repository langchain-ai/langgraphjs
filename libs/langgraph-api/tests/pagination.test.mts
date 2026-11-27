import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import assistantsRoutes from "../src/api/assistants.mjs";
import threadsRoutes from "../src/api/threads.mjs";
import { FileSystemOps } from "../src/storage/ops.mjs";
import { FileSystemPersistence } from "../src/storage/persist.mjs";
import type { Store, StorageEnv } from "../src/storage/types.mjs";

const SEED_COUNT = 25;
const DEFAULT_LIMIT = 10;

const cwds: string[] = [];
let conn: FileSystemPersistence<Store>;
let app: Hono<StorageEnv>;

beforeEach(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lg-api-pagination-"));
  cwds.push(cwd);

  conn = new FileSystemPersistence<Store>(".langgraphjs_ops.json", () => ({
    runs: {},
    threads: {},
    assistants: {},
    assistant_versions: [],
    retry_counter: {},
  }));
  const ops = new FileSystemOps(await conn.initialize(cwd));

  app = new Hono<StorageEnv>();
  app.use(contextStorage());
  app.use(async (c, next) => {
    c.set("LANGGRAPH_OPS", ops);
    await next();
  });
  app.route("/", assistantsRoutes);
  app.route("/", threadsRoutes);

  for (let i = 0; i < SEED_COUNT; i++) {
    await ops.assistants.put(
      `assistant-${i}`,
      {
        config: {},
        context: {},
        graph_id: "agent",
        metadata: { index: i },
        if_exists: "raise",
        name: `Assistant ${i}`,
      },
      undefined
    );
    await ops.threads.put(
      randomUUID(),
      { metadata: { index: i }, if_exists: "raise" },
      undefined
    );
  }
});

afterEach(async () => {
  // FileSystemPersistence schedules a debounced flush on every write; flushing
  // here both persists the seed and cancels the pending timer.
  await conn.flush();
});

afterAll(() => {
  for (const cwd of cwds) rmSync(cwd, { recursive: true, force: true });
});

type SearchPath = "/assistants/search" | "/threads/search";

async function search(path: SearchPath, body: Record<string, unknown>) {
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return {
    items: (await response.json()) as unknown[],
    next: response.headers.get("X-Pagination-Next"),
    total: response.headers.get("X-Pagination-Total"),
  };
}

for (const path of ["/assistants/search", "/threads/search"] as const) {
  describe(`${path} X-Pagination-Next`, () => {
    it("emits a cursor for the default limit and stops on the final page", async () => {
      const first = await search(path, {});
      expect(first.items).toHaveLength(DEFAULT_LIMIT);
      expect(first.next).toBe(String(DEFAULT_LIMIT));
      expect(first.total).toBe(String(SEED_COUNT));

      const second = await search(path, {
        limit: DEFAULT_LIMIT,
        offset: Number(first.next),
      });
      expect(second.items).toHaveLength(DEFAULT_LIMIT);
      expect(second.next).toBe(String(DEFAULT_LIMIT * 2));

      const final = await search(path, {
        limit: DEFAULT_LIMIT,
        offset: Number(second.next),
      });
      expect(final.items).toHaveLength(SEED_COUNT - DEFAULT_LIMIT * 2);
      expect(final.next).toBeNull();
    });

    it("emits a cursor when limit is given explicitly", async () => {
      const first = await search(path, { limit: DEFAULT_LIMIT });
      expect(first.items).toHaveLength(DEFAULT_LIMIT);
      expect(first.next).toBe(String(DEFAULT_LIMIT));

      const final = await search(path, {
        limit: DEFAULT_LIMIT,
        offset: Number(first.next),
      });
      expect(final.items).toHaveLength(DEFAULT_LIMIT);
      expect(final.next).toBe(String(DEFAULT_LIMIT * 2));

      const last = await search(path, {
        limit: DEFAULT_LIMIT,
        offset: Number(final.next),
      });
      expect(last.items).toHaveLength(SEED_COUNT - DEFAULT_LIMIT * 2);
      expect(last.next).toBeNull();

      const exhausted = await search(path, {
        limit: DEFAULT_LIMIT,
        offset: SEED_COUNT,
      });
      expect(exhausted.items).toHaveLength(0);
      expect(exhausted.next).toBeNull();
    });

    it("emits a cursor for a full page starting at a non-zero offset", async () => {
      const offset = 5;
      const page = await search(path, { limit: DEFAULT_LIMIT, offset });
      expect(page.items).toHaveLength(DEFAULT_LIMIT);
      expect(page.next).toBe(String(offset + DEFAULT_LIMIT));
      expect(page.total).toBe(String(offset + SEED_COUNT));
    });

    it("omits the cursor when limit equals the total but the page is partial", async () => {
      const offset = 10;
      const page = await search(path, { limit: SEED_COUNT, offset });
      expect(page.items).toHaveLength(SEED_COUNT - offset);
      expect(page.next).toBeNull();
      expect(page.total).toBe(String(offset + SEED_COUNT + 1));
    });
  });
}
