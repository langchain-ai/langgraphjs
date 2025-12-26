/**
 * Browser Tools: Long-Term Memory Example
 *
 * This example demonstrates browser tools that provide durable, user-controlled
 * memory using IndexedDB. The agent can remember user preferences, facts, and
 * context across sessions - all stored locally in the browser.
 *
 * Key benefits over server-side memory:
 * - Persists across sessions without login
 * - Privacy-friendly (data never leaves device)
 * - Per-user + per-device by default
 * - Low-latency recall without server roundtrips
 */

import { browserTool } from "langchain";
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
      reject(new Error("Database blocked - please close other tabs using this app"));
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
// Memory Browser Tools
// ============================================================================

/**
 * Store a memory in the browser's local database.
 * Use this to remember user preferences, facts, or context across sessions.
 */
export const memoryPut = browserTool(
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

    // Check if updating existing memory
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
  },
  {
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
  }
);

/**
 * Retrieve a specific memory by key.
 */
export const memoryGet = browserTool(
  async ({ key }) => {
    const memory = await withStore<Memory | undefined>("readonly", (store) =>
      store.get(key)
    );

    if (!memory) {
      return {
        found: false,
        key,
        message: `No memory found with key "${key}"`,
      };
    }

    // Check if expired
    if (memory.expiresAt && memory.expiresAt < new Date().toISOString()) {
      // Clean up expired memory
      await withStore("readwrite", (store) => store.delete(key));
      return {
        found: false,
        key,
        message: `Memory "${key}" has expired`,
      };
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
  },
  {
    name: "memory_get",
    description:
      "Retrieve a specific memory by its key. " +
      "Use this to recall previously stored information like user preferences or saved context.",
    schema: z.object({
      key: z.string().describe("The key of the memory to retrieve"),
    }),
  }
);

/**
 * List all memories, optionally filtered by tags.
 */
export const memoryList = browserTool(
  async ({ tags, limit = 20 }) => {
    let memories = await getAllMemories();

    // Filter by tags if provided
    if (tags && tags.length > 0) {
      memories = memories.filter((m) =>
        tags.some((tag) => m.tags.includes(tag))
      );
    }

    // Sort by most recently updated
    memories.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    // Apply limit
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
  },
  {
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
  }
);

/**
 * Search memories by content.
 */
export const memorySearch = browserTool(
  async ({ query, tags, limit = 10 }) => {
    let memories = await getAllMemories();

    // Filter by tags if provided
    if (tags && tags.length > 0) {
      memories = memories.filter((m) =>
        tags.some((tag) => m.tags.includes(tag))
      );
    }

    // Simple text search across key and value
    const queryLower = query.toLowerCase();
    const matches = memories.filter((m) => {
      const keyMatch = m.key.toLowerCase().includes(queryLower);
      const valueStr =
        typeof m.value === "string"
          ? m.value
          : JSON.stringify(m.value);
      const valueMatch = valueStr.toLowerCase().includes(queryLower);
      const tagMatch = m.tags.some((t) =>
        t.toLowerCase().includes(queryLower)
      );
      return keyMatch || valueMatch || tagMatch;
    });

    // Sort by relevance (exact key match first, then by recency)
    matches.sort((a, b) => {
      const aExact = a.key.toLowerCase() === queryLower;
      const bExact = b.key.toLowerCase() === queryLower;
      if (aExact && !bExact) return -1;
      if (bExact && !aExact) return 1;
      return (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
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
  },
  {
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
  }
);

/**
 * Delete a memory or all memories matching a tag.
 */
export const memoryForget = browserTool(
  async ({ key, tag, confirmForgetAll }) => {
    if (!key && !tag) {
      if (confirmForgetAll) {
        // Delete all memories
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
      // Delete all memories with this tag
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
  },
  {
    name: "memory_forget",
    description:
      "Delete a memory by key, all memories with a tag, or clear all memories. " +
      "Use this when the user asks you to forget something.",
    schema: z.object({
      key: z.string().optional().describe("The key of the memory to delete"),
      tag: z
        .string()
        .optional()
        .describe("Delete all memories with this tag"),
      confirmForgetAll: z
        .boolean()
        .optional()
        .describe("Set to true to delete ALL memories (use with caution)"),
    }),
  }
);

// Export all browser tools as an array for easy registration
export const browserTools = [
  memoryPut,
  memoryGet,
  memoryList,
  memorySearch,
  memoryForget,
];
