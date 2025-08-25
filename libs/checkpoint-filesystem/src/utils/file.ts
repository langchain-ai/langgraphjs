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

// Constants
const LOCK_FILE_SUFFIX = ".lock";
const LOCK_TIMEOUT_MS = 30000; // 30 seconds timeout
const LOCK_CHECK_INTERVAL_MS = 10;
const MAX_LOCK_ATTEMPTS = Math.ceil(LOCK_TIMEOUT_MS / LOCK_CHECK_INTERVAL_MS);

// Error type definitions
class FileLockError extends Error {
  constructor(message: string, public readonly filePath: string) {
    super(message);
    this.name = "FileLockError";
  }
}

class FileOperationError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly filePath?: string
  ) {
    super(message);
    this.name = "FileOperationError";
  }
}

// File lock manager
class FileLockManager {
  private readonly locks = new Map<string, Promise<void>>();

  async acquireLock(filePath: string): Promise<void> {
    const lockKey = filePath;

    // If lock already exists, wait for the existing lock to complete
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
    const lockFilePath = `${filePath}${LOCK_FILE_SUFFIX}`;

    try {
      await unlink(lockFilePath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // Ignore file not found errors
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
    const lockFilePath = `${filePath}${LOCK_FILE_SUFFIX}`;

    try {
      const fd = await open(lockFilePath, "wx");
      await fd.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.code === "EEXIST") {
        await this.waitForLockRelease(lockFilePath);
        return this.createFileLock(filePath);
      }
      throw new FileLockError(
        `Failed to create lock file: ${error.message}`,
        filePath
      );
    }
  }

  private async waitForLockRelease(lockFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;

      const checkLock = async () => {
        attempts += 1;

        if (attempts > MAX_LOCK_ATTEMPTS) {
          reject(
            new FileLockError(
              `Lock timeout for ${lockFilePath} after ${LOCK_TIMEOUT_MS}ms`,
              lockFilePath
            )
          );
          return;
        }

        try {
          await access(lockFilePath);
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          setTimeout(checkLock, LOCK_CHECK_INTERVAL_MS);
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
      return await operation();
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

// Singleton lock manager
const lockManager = new FileLockManager();

// Utility functions
export const ensureDirectoryExists = async (
  basePath: string
): Promise<void> => {
  try {
    await access(basePath);
  } catch {
    await mkdir(basePath, { recursive: true });
  }
};

// Thread data file types
type ThreadDataFileType = "storage" | "writes";

// File thread data storage class
export class FileThreadDataStorage {
  private readonly basePath: string;

  private readonly fileExtension: string;

  constructor(basePath: string, fileExtension: string) {
    this.basePath = basePath;
    this.fileExtension = fileExtension;
  }

  private _getThreadFilePath(
    threadId: string,
    type: ThreadDataFileType
  ): string {
    return join(this.basePath, `${threadId}.${type}${this.fileExtension}`);
  }

  private async _checkThreadFileExists(
    threadId: string,
    type: ThreadDataFileType
  ): Promise<boolean> {
    const filePath = this._getThreadFilePath(threadId, type);
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private _createEmptyThreadData<
    T extends IFileSaverStorageData | IFileSaverWritesData
  >(type: ThreadDataFileType): T {
    return (type === "storage" ? { storage: {} } : { writes: {} }) as T;
  }

  async loadThreadData<T extends IFileSaverStorageData | IFileSaverWritesData>(
    threadId: string,
    type: ThreadDataFileType
  ): Promise<T> {
    const filePath = this._getThreadFilePath(threadId, type);

    return lockManager.withLock(filePath, async () => {
      const fileExists = await this._checkThreadFileExists(threadId, type);

      if (fileExists) {
        try {
          const fileContent = await readFile(filePath, "utf-8");
          return JSON.parse(fileContent) as T;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          throw new FileOperationError(
            `Failed to read thread data: ${error.message}`,
            "read",
            filePath
          );
        }
      } else {
        const emptyData = this._createEmptyThreadData<T>(type);

        try {
          await ensureDirectoryExists(this.basePath);
          await writeFile(
            filePath,
            JSON.stringify(emptyData, null, 2),
            "utf-8"
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          throw new FileOperationError(
            `Failed to create thread data file: ${error.message}`,
            "create",
            filePath
          );
        }

        return emptyData;
      }
    });
  }

  async saveThreadData<T extends IFileSaverStorageData | IFileSaverWritesData>(
    threadId: string,
    data: T,
    type: ThreadDataFileType
  ): Promise<void> {
    const filePath = this._getThreadFilePath(threadId, type);

    return lockManager.withLock(filePath, async () => {
      try {
        await ensureDirectoryExists(this.basePath);
        await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        throw new FileOperationError(
          `Failed to save thread data: ${error.message}`,
          "write",
          filePath
        );
      }
    });
  }

  async cleanAllThreadData(): Promise<void> {
    try {
      const threadIds = await readdir(this.basePath);

      const cleanupPromises = threadIds.map(async (threadId) => {
        const storagePath = this._getThreadFilePath(threadId, "storage");
        const writesPath = this._getThreadFilePath(threadId, "writes");

        await Promise.all([
          this.deleteFileWithLock(storagePath),
          this.deleteFileWithLock(writesPath),
        ]);
      });

      await Promise.all(cleanupPromises);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return;
      }
      throw new FileOperationError(
        `Failed to clean thread data: ${error.message}`,
        "cleanup",
        this.basePath
      );
    }
  }

  private async deleteFileWithLock(filePath: string): Promise<void> {
    return lockManager.withLock(filePath, async () => {
      try {
        await unlink(filePath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        // 忽略文件不存在的错误
        if (error.code !== "ENOENT") {
          throw new FileOperationError(
            `Failed to delete file: ${error.message}`,
            "delete",
            filePath
          );
        }
      }
    });
  }

  async getAllThreadIds(): Promise<string[]> {
    try {
      const files = await readdir(this.basePath);
      // 过滤出有效的线程ID（去掉文件扩展名）
      return files
        .filter((file) => file.includes("."))
        .map((file) => file.split(".")[0])
        .filter((id, index, arr) => arr.indexOf(id) === index); // 去重
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw new FileOperationError(
        `Failed to get thread IDs: ${error.message}`,
        "list",
        this.basePath
      );
    }
  }

  async threadExists(threadId: string): Promise<boolean> {
    const storageExists = await this._checkThreadFileExists(
      threadId,
      "storage"
    );
    const writesExists = await this._checkThreadFileExists(threadId, "writes");
    return storageExists || writesExists;
  }
}
