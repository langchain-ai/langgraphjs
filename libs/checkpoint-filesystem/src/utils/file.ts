import {
  access,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
  open,
} from "fs/promises";
import { join } from "path";
import { IFileSaverStorageData, IFileSaverWritesData } from "../types.js";

class FileLockManager {
  private locks = new Map<string, Promise<void>>();

  async acquireLock(filePath: string): Promise<void> {
    const lockKey = filePath;

    if (this.locks.has(lockKey)) {
      await this.locks.get(lockKey);
    }

    const lockPromise = this.createFileLock(filePath);
    this.locks.set(lockKey, lockPromise);

    try {
      await lockPromise;
    } catch (error) {
      this.locks.delete(lockKey);
      throw error;
    }
  }

  async releaseLock(filePath: string): Promise<void> {
    const lockKey = filePath;
    const lockFilePath = `${filePath}.lock`;

    try {
      await unlink(lockFilePath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        console.warn(
          `Failed to remove lock file ${lockFilePath}:`,
          error.message
        );
      }
    } finally {
      this.locks.delete(lockKey);
    }
  }

  private async createFileLock(filePath: string): Promise<void> {
    const lockFilePath = `${filePath}.lock`;

    try {
      const fd = await open(lockFilePath, "wx");
      await fd.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.code === "EEXIST") {
        await this.waitForLockRelease(lockFilePath);
        return this.createFileLock(filePath);
      }
      throw error;
    }
  }

  private async waitForLockRelease(lockFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 3000;

      const checkLock = async () => {
        attempts += 1;

        if (attempts > maxAttempts) {
          reject(
            new Error(
              `Lock timeout for ${lockFilePath} after ${maxAttempts * 10}ms`
            )
          );
          return;
        }

        try {
          await access(lockFilePath);
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          void setTimeout(checkLock, 10);
        } catch {
          resolve();
        }
      };

      void checkLock();
    });
  }

  async withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    await this.acquireLock(filePath);
    try {
      const result = await operation();
      return result;
    } finally {
      await this.releaseLock(filePath);
    }
  }

  async cleanupAllLocks(): Promise<void> {
    const lockPromises = Array.from(this.locks.keys()).map((filePath) =>
      this.releaseLock(filePath)
    );
    await Promise.all(lockPromises);
  }
}

const lockManager = new FileLockManager();

export const ensureDirectoryExists = async (basePath: string) => {
  try {
    await access(basePath);
  } catch {
    await mkdir(basePath, { recursive: true });
  }
};

type ThreadDataFileType = "storage" | "writes";

export class FileThreadDataStorage {
  private readonly basePath: string;

  private readonly fileExtension: string;

  constructor(basePath: string, fileExtension: string) {
    this.basePath = basePath;
    this.fileExtension = fileExtension;
  }

  private _getThreadFilePath(threadId: string, type: ThreadDataFileType) {
    // threadId.storage.json or threadId.writes.json
    return join(this.basePath, `${threadId}.${type}${this.fileExtension}`);
  }

  private async _checkThreadFileExists(
    threadId: string,
    type: ThreadDataFileType
  ) {
    const filePath = this._getThreadFilePath(threadId, type);
    return access(filePath)
      .then(() => true)
      .catch(() => false);
  }

  // read or create - protected by file lock
  async loadThreadData<T extends IFileSaverStorageData | IFileSaverWritesData>(
    threadId: string,
    type: ThreadDataFileType
  ): Promise<T> {
    const filePath = this._getThreadFilePath(threadId, type);

    return lockManager.withLock(filePath, async () => {
      const fileExists = await this._checkThreadFileExists(threadId, type);

      if (fileExists) {
        const fileContent = await readFile(filePath, "utf-8");
        return JSON.parse(fileContent) as T;
      } else {
        const emptyData: T =
          type === "storage" ? ({ storage: {} } as T) : ({ writes: {} } as T);

        await writeFile(filePath, JSON.stringify(emptyData), "utf-8");

        return emptyData;
      }
    });
  }

  // save - protected by file lock
  async saveThreadData<T extends IFileSaverStorageData | IFileSaverWritesData>(
    threadId: string,
    data: T,
    type: ThreadDataFileType
  ) {
    const filePath = this._getThreadFilePath(threadId, type);

    return lockManager.withLock(filePath, async () => {
      await ensureDirectoryExists(this.basePath);
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    });
  }

  // clean all thread data - protected by file lock
  async cleanAllThreadData() {
    const threadIds = await readdir(this.basePath);

    const cleanupPromises = threadIds.map(async (threadId) => {
      const storagePath = this._getThreadFilePath(threadId, "storage");

      const writesPath = this._getThreadFilePath(threadId, "writes");

      // Clean up in parallel, but each file has independent locks
      await Promise.all([
        lockManager.withLock(storagePath, async () => {
          try {
            await unlink(storagePath);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (error: any) {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }
        }),
        lockManager.withLock(writesPath, async () => {
          try {
            await unlink(writesPath);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (error: any) {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }
        }),
      ]);
    });

    await Promise.all(cleanupPromises);
  }
}
