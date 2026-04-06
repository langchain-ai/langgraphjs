/**
 * Headless Tools: Long-Term Memory Example
 *
 * This example demonstrates headless tools that provide durable, user-controlled
 * memory using IndexedDB. The agent can remember user preferences, facts, and
 * context across sessions - all stored locally in the browser.
 *
 * Key benefits over server-side memory:
 * - Persists across sessions without login
 * - Privacy-friendly (data never leaves device)
 * - Per-user + per-device by default
 * - Low-latency recall without server roundtrips
 *
 * Geolocation (`geolocation_get`) is additionally gated in `agent.ts` with
 * `humanInTheLoopMiddleware` so each request is approved in the UI before the
 * client runs this tool.
 */

import { tool } from "langchain";
import { z } from "zod/v4";

// ============================================================================
// IndexedDB Memory Store
// ============================================================================

const DB_NAME = "agent-memory";
const DB_VERSION = 2; // Increment version to force upgrade
const STORE_NAME = "memories";

interface Memory {
  key: string;
  value: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

/**
 * Delete the database and recreate it (for recovery from corrupt state)
 */
function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Failed to delete database"));
    request.onblocked = () => resolve(); // Proceed anyway
  });
}

/**
 * Open the IndexedDB database, creating the object store if needed.
 * Will recreate the database if the store is missing.
 */
async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error("Failed to open memory database"));
    };

    request.onsuccess = () => {
      const db = request.result;
      // Verify the store exists
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        // Delete and retry - the store should be created on next open
        deleteDatabase()
          .then(() => openDB())
          .then(resolve)
          .catch(reject);
        return;
      }
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Delete old store if it exists (clean upgrade)
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }

      // Create the object store with indexes
      const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex("tags", "tags", { multiEntry: true });
      store.createIndex("createdAt", "createdAt");
      store.createIndex("updatedAt", "updatedAt");
    };

    request.onblocked = () => {
      reject(
        new Error("Database blocked - please close other tabs using this app")
      );
    };
  });
}

/**
 * Perform a transaction on the memory store.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = callback(store);

      transaction.oncomplete = () => {
        db.close();
      };

      transaction.onerror = () => {
        db.close();
        reject(new Error("Memory operation failed"));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(new Error("Memory operation failed"));
      };
    } catch (err) {
      db.close();
      reject(err);
    }
  });
}

/**
 * Get all memories from the store.
 */
async function getAllMemories(): Promise<Memory[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      transaction.oncomplete = () => {
        db.close();
      };

      transaction.onerror = () => {
        db.close();
        reject(new Error("Failed to list memories"));
      };

      request.onsuccess = () => {
        // Filter out expired memories
        const now = new Date().toISOString();
        const memories = (request.result as Memory[]).filter(
          (m) => !m.expiresAt || m.expiresAt > now
        );
        resolve(memories);
      };

      request.onerror = () => {
        reject(new Error("Failed to list memories"));
      };
    } catch (err) {
      db.close();
      reject(err);
    }
  });
}

// ============================================================================
// Memory Headless Tools
// ============================================================================

/**
 * Store a memory in the browser's local database.
 * Use this to remember user preferences, facts, or context across sessions.
 */
export const memoryPut = tool({
  name: "memory_put",
  description:
    "Store a memory in the user's browser for long-term recall. " +
    "Use this to save user preferences, important facts, or context that should persist across sessions. " +
    "Memories are stored locally and never leave the user's device.",
  schema: z.object({
    key: z
      .string()
      .describe(
        "Unique identifier for this memory (e.g., 'user_name', 'preferred_language', 'meeting_notes_2024')"
      ),
    value: z
      .unknown()
      .describe(
        "The value to store - can be a string, object, or any JSON-serializable data"
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Tags to categorize this memory for easier recall (e.g., ['preference', 'work'])"
      ),
    ttlDays: z
      .number()
      .optional()
      .describe(
        "Optional: Number of days until this memory expires (omit for permanent)"
      ),
  }),
});

export const memoryPutImpl = memoryPut.implement(
  async ({ key, value, tags = [], ttlDays }) => {
    const now = new Date();
    const memory: Memory = {
      key,
      value,
      tags,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: ttlDays
        ? new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined,
    };

    const existing = await withStore("readonly", (store) => store.get(key));
    if (existing) {
      memory.createdAt = existing.createdAt;
    }

    await withStore("readwrite", (store) => store.put(memory));

    return {
      success: true,
      action: existing ? "updated" : "created",
      key,
      message: `Memory "${key}" ${existing ? "updated" : "saved"}${
        ttlDays ? ` (expires in ${ttlDays} days)` : ""
      }`,
    };
  }
);

/**
 * Retrieve a specific memory by key.
 */
export const memoryGet = tool({
  name: "memory_get",
  description:
    "Retrieve a specific memory by its key. " +
    "Use this to recall previously stored information like user preferences or saved context.",
  schema: z.object({
    key: z.string().describe("The key of the memory to retrieve"),
  }),
});

export const memoryGetImpl = memoryGet.implement(async ({ key }) => {
  const memory = await withStore<Memory | undefined>("readonly", (store) =>
    store.get(key)
  );

  if (!memory) {
    return { found: false, key, message: `No memory found with key "${key}"` };
  }

  if (memory.expiresAt && memory.expiresAt < new Date().toISOString()) {
    await withStore("readwrite", (store) => store.delete(key));
    return { found: false, key, message: `Memory "${key}" has expired` };
  }

  return {
    found: true,
    key,
    value: memory.value,
    tags: memory.tags,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    expiresAt: memory.expiresAt,
  };
});

/**
 * List all memories, optionally filtered by tags.
 */
export const memoryList = tool({
  name: "memory_list",
  description:
    "List all stored memories, optionally filtered by tags. " +
    "Use this to see what the user has asked you to remember or to find relevant context.",
  schema: z.object({
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter memories by these tags"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of memories to return (default 20)"),
  }),
});

export const memoryListImpl = memoryList.implement(
  async ({ tags, limit = 20 }) => {
    let memories = await getAllMemories();

    if (tags && tags.length > 0) {
      memories = memories.filter((m) =>
        tags.some((tag: string) => m.tags.includes(tag))
      );
    }

    memories.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    memories = memories.slice(0, limit);

    return {
      count: memories.length,
      memories: memories.map((m) => ({
        key: m.key,
        value: m.value,
        tags: m.tags,
        updatedAt: m.updatedAt,
      })),
    };
  }
);

/**
 * Search memories by content.
 */
export const memorySearch = tool({
  name: "memory_search",
  description:
    "Search through stored memories by content. " +
    "Use this to find relevant memories when you're not sure of the exact key.",
  schema: z.object({
    query: z.string().describe("Search query to find matching memories"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Optionally filter search to memories with these tags"),
    limit: z
      .number()
      .optional()
      .describe("Maximum results to return (default 10)"),
  }),
});

export const memorySearchImpl = memorySearch.implement(
  async ({ query, tags, limit = 10 }) => {
    let memories = await getAllMemories();

    if (tags && tags.length > 0) {
      memories = memories.filter((m) =>
        tags.some((tag: string) => m.tags.includes(tag))
      );
    }

    const queryLower = query.toLowerCase();
    const matches = memories.filter((m) => {
      const keyMatch = m.key.toLowerCase().includes(queryLower);
      const valueStr =
        typeof m.value === "string" ? m.value : JSON.stringify(m.value);
      const valueMatch = valueStr.toLowerCase().includes(queryLower);
      const tagMatch = m.tags.some((t) => t.toLowerCase().includes(queryLower));
      return keyMatch || valueMatch || tagMatch;
    });

    matches.sort((a, b) => {
      const aExact = a.key.toLowerCase() === queryLower;
      const bExact = b.key.toLowerCase() === queryLower;
      if (aExact && !bExact) return -1;
      if (bExact && !aExact) return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return {
      query,
      count: Math.min(matches.length, limit),
      total: matches.length,
      results: matches.slice(0, limit).map((m) => ({
        key: m.key,
        value: m.value,
        tags: m.tags,
        updatedAt: m.updatedAt,
      })),
    };
  }
);

/**
 * Delete a memory or all memories matching a tag.
 */
export const memoryForget = tool({
  name: "memory_forget",
  description:
    "Delete a memory by key, all memories with a tag, or clear all memories. " +
    "Use this when the user asks you to forget something.",
  schema: z.object({
    key: z.string().optional().describe("The key of the memory to delete"),
    tag: z.string().optional().describe("Delete all memories with this tag"),
    confirmForgetAll: z
      .boolean()
      .optional()
      .describe("Set to true to delete ALL memories (use with caution)"),
  }),
});

export const memoryForgetImpl = memoryForget.implement(
  async ({ key, tag, confirmForgetAll }) => {
    if (!key && !tag) {
      if (confirmForgetAll) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, "readwrite");
          const store = transaction.objectStore(STORE_NAME);
          const request = store.clear();

          request.onsuccess = () => {
            db.close();
            resolve({
              success: true,
              action: "cleared_all",
              message: "All memories have been forgotten",
            });
          };
          request.onerror = () => {
            db.close();
            reject(new Error("Failed to clear memories"));
          };
        });
      }
      return {
        success: false,
        message:
          "Please specify a key or tag to forget, or set confirmForgetAll to true",
      };
    }

    if (key) {
      const existing = await withStore<Memory | undefined>(
        "readonly",
        (store) => store.get(key)
      );
      if (!existing) {
        return {
          success: false,
          key,
          message: `No memory found with key "${key}"`,
        };
      }
      await withStore("readwrite", (store) => store.delete(key));
      return {
        success: true,
        action: "deleted",
        key,
        message: `Memory "${key}" has been forgotten`,
      };
    }

    if (tag) {
      const memories = await getAllMemories();
      const toDelete = memories.filter((m) => m.tags.includes(tag));

      for (const memory of toDelete) {
        await withStore("readwrite", (store) => store.delete(memory.key));
      }

      return {
        success: true,
        action: "deleted_by_tag",
        tag,
        count: toDelete.length,
        message: `Forgotten ${toDelete.length} memories with tag "${tag}"`,
      };
    }

    return { success: false, message: "Unexpected state" };
  }
);

// ============================================================================
// Geolocation Headless Tool
// ============================================================================

/**
 * Get the user's current location using the browser Geolocation API and
 * persist it to the IndexedDB memory store so the agent can reference it
 * in future turns without asking again.
 */
export const geolocationGet = tool({
  name: "geolocation_get",
  description:
    "Get the user's current GPS coordinates using the browser's Geolocation API. " +
    "Saves latitude, longitude, accuracy, and timestamp to the local memory store " +
    "so they can be referenced in future conversations without asking again. " +
    "The browser will prompt the user for permission the first time this is called.",
  schema: z.object({
    save: z
      .boolean()
      .optional()
      .describe(
        "Save the location to memory for future reference (default true)"
      ),
  }),
});

export const geolocationGetImpl = geolocationGet.implement(
  async ({ save = true }) => {
    if (!navigator.geolocation) {
      return {
        success: false,
        message: "Geolocation is not supported by this browser.",
      };
    }

    const position = await new Promise<GeolocationPosition>(
      (resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 5 * 60 * 1_000,
        });
      }
    );

    const { latitude, longitude, accuracy } = position.coords;
    const timestamp = new Date(position.timestamp).toISOString();
    const locationData = { latitude, longitude, accuracy, timestamp };

    if (save) {
      const now = new Date();
      const memory: Memory = {
        key: "user_location",
        value: locationData,
        tags: ["location", "geolocation"],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await withStore("readwrite", (store) => store.put(memory));
    }

    return {
      success: true,
      saved: save,
      latitude,
      longitude,
      accuracy,
      timestamp,
      message: `Location determined: ${latitude.toFixed(
        5
      )}, ${longitude.toFixed(5)} (±${Math.round(accuracy)} m)`,
    };
  }
);

// Headless tool definitions — pass these to createAgent on the server
export const headlessTools = [
  memoryPut,
  memoryGet,
  memoryList,
  memorySearch,
  memoryForget,
  geolocationGet,
];

// Implementations — pass these to useStream on the client via `tools: [...]`
export const toolImplementations = [
  memoryPutImpl,
  memoryGetImpl,
  memoryListImpl,
  memorySearchImpl,
  memoryForgetImpl,
  geolocationGetImpl,
];
