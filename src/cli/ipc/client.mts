// https://github.com/privatenumber/tsx/tree/28a3e7d2b8fd72b683aab8a98dd1fcee4624e4cb
import net from "node:net";
import { getPipePath } from "./utils/get-pipe-path.mjs";

export type SendToParent = (data: Record<string, unknown>) => void;
export type Parent = { send: SendToParent | undefined };

export const connectToServer = (processId = process.ppid) =>
  new Promise<SendToParent | undefined>((resolve) => {
    const pipePath = getPipePath(processId);
    const socket: net.Socket = net.createConnection(pipePath, () => {
      const sendToParent: SendToParent = (data) => {
        const messageBuffer = Buffer.from(JSON.stringify(data));
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeInt32BE(messageBuffer.length, 0);
        socket.write(Buffer.concat([lengthBuffer, messageBuffer]));
      };
      resolve(sendToParent);
    });

    /**
     * Ignore error when:
     * - Called as a loader and there is no server
     * - Nested process when using --test and the ppid is incorrect
     */
    socket.on("error", () => {
      resolve(undefined);
    });

    // Prevent Node from waiting for this socket to close before exiting
    socket.unref();
  });
