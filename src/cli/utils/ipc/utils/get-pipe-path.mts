// https://github.com/privatenumber/tsx/tree/28a3e7d2b8fd72b683aab8a98dd1fcee4624e4cb
import path from "node:path";
import { tmpdir } from "./temporary-directory.mjs";

export const getPipePath = (processId: number) => {
  const pipePath = path.join(tmpdir, `${processId}.pipe`);
  return process.platform === "win32" ? `\\\\?\\pipe\\${pipePath}` : pipePath;
};
