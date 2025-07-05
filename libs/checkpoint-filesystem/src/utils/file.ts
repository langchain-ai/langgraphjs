import {
  access,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "fs/promises";
import { join } from "path";
import { IFileSaverStorageData, IFileSaverWritesData } from "../types.js";

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

  constructor(basePath: string, fileExtension = ".json") {
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

  // read or create
  async loadThreadData<T extends IFileSaverStorageData | IFileSaverWritesData>(
    threadId: string,
    type: ThreadDataFileType
  ): Promise<T> {
    const fileExists = await this._checkThreadFileExists(threadId, type);

    const filePath = this._getThreadFilePath(threadId, type);

    if (fileExists) {
      const fileContent = await readFile(filePath, "utf-8");
      return JSON.parse(fileContent) as T;
    } else {
      const emptyData: T =
        type === "storage" ? ({ storage: {} } as T) : ({ writes: {} } as T);

      await writeFile(filePath, JSON.stringify(emptyData), "utf-8");

      return emptyData;
    }
  }

  // save
  async saveThreadData<T extends IFileSaverStorageData | IFileSaverWritesData>(
    threadId: string,
    data: T,
    type: ThreadDataFileType
  ) {
    await ensureDirectoryExists(this.basePath);
    const filePath = this._getThreadFilePath(threadId, type);
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // clean all thread data
  async cleanAllThreadData() {
    const threadIds = await readdir(this.basePath);
    await Promise.all(
      threadIds.map((threadId) =>
        unlink(this._getThreadFilePath(threadId, "storage"))
      )
    );
    await Promise.all(
      threadIds.map((threadId) =>
        unlink(this._getThreadFilePath(threadId, "writes"))
      )
    );
  }
}
