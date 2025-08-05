// MIT License
//
// Copyright (c) Hiroki Osame <hiroki.osame@gmail.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
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
