import {
  geolocationGet,
  memoryForget,
  memoryGet,
  memoryList,
  memoryPut,
  memorySearch,
} from "./definition";

const DB_NAME = "langgraph-ui-streaming-memory";
const DB_VERSION = 1;
const STORE_NAME = "memories";

export interface MemoryRecord {
  key: string;
  value: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

function openMemoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(new Error("Failed to open memory store."));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("tags", "tags", { multiEntry: true });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openMemoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Memory operation failed."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(new Error("Memory transaction failed."));
    };
  });
}

export async function listMemories(): Promise<MemoryRecord[]> {
  const memories = await withStore<MemoryRecord[]>("readonly", (store) =>
    store.getAll()
  );
  const now = new Date().toISOString();
  return memories
    .filter((memory) => memory.expiresAt == null || memory.expiresAt > now)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
}

export const toolImplementations = [
  memoryPut.implement(async ({ key, value, tags = [], ttlDays }) => {
    const now = new Date();
    const existing = await withStore<MemoryRecord | undefined>(
      "readonly",
      (store) => store.get(key)
    );
    const memory: MemoryRecord = {
      key,
      value,
      tags,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt:
        ttlDays == null
          ? undefined
          : new Date(now.getTime() + ttlDays * 86_400_000).toISOString(),
    };
    await withStore("readwrite", (store) => store.put(memory));
    return {
      success: true,
      action: existing ? "updated" : "created",
      key,
    };
  }),
  memoryGet.implement(async ({ key }) => {
    const memory = await withStore<MemoryRecord | undefined>(
      "readonly",
      (store) => store.get(key)
    );
    return memory == null
      ? { found: false, key }
      : { found: true, ...memory };
  }),
  memoryList.implement(async ({ tags, limit = 20 }) => {
    let memories = await listMemories();
    if (tags?.length) {
      memories = memories.filter((memory) =>
        tags.some((tag) => memory.tags.includes(tag))
      );
    }
    return { count: memories.length, memories: memories.slice(0, limit) };
  }),
  memorySearch.implement(async ({ query, tags, limit = 10 }) => {
    const queryLower = query.toLowerCase();
    let memories = await listMemories();
    if (tags?.length) {
      memories = memories.filter((memory) =>
        tags.some((tag) => memory.tags.includes(tag))
      );
    }
    const results = memories.filter((memory) => {
      const value =
        typeof memory.value === "string"
          ? memory.value
          : JSON.stringify(memory.value);
      return [memory.key, value, ...memory.tags].some((part) =>
        part.toLowerCase().includes(queryLower)
      );
    });
    return { query, count: results.length, results: results.slice(0, limit) };
  }),
  memoryForget.implement(async ({ key, tag, confirmForgetAll }) => {
    if (confirmForgetAll) {
      const db = await openMemoryDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const request = tx.objectStore(STORE_NAME).clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error("Failed to clear memories."));
        tx.oncomplete = () => db.close();
      });
      return { success: true, action: "cleared_all" };
    }
    if (key != null) {
      await withStore("readwrite", (store) => store.delete(key));
      return { success: true, action: "deleted", key };
    }
    if (tag != null) {
      const memories = await listMemories();
      const matching = memories.filter((memory) => memory.tags.includes(tag));
      for (const memory of matching) {
        await withStore("readwrite", (store) => store.delete(memory.key));
      }
      return {
        success: true,
        action: "deleted_by_tag",
        tag,
        count: matching.length,
      };
    }
    return { success: false, message: "Specify key, tag, or confirmForgetAll." };
  }),
  geolocationGet.implement(async ({ save = true }) => {
    if (!navigator.geolocation) {
      return { success: false, message: "Geolocation is not supported." };
    }
    const position = await new Promise<GeolocationPosition>(
      (resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 300_000,
        });
      }
    );
    const { latitude, longitude, accuracy } = position.coords;
    const value = {
      latitude,
      longitude,
      accuracy,
      timestamp: new Date(position.timestamp).toISOString(),
    };
    if (save) {
      const now = new Date().toISOString();
      await withStore("readwrite", (store) =>
        store.put({
          key: "user_location",
          value,
          tags: ["location", "geolocation"],
          createdAt: now,
          updatedAt: now,
        } satisfies MemoryRecord)
      );
    }
    return { success: true, saved: save, ...value };
  }),
];
