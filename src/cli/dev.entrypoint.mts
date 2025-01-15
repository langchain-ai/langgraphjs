import "../preload.mjs";

import * as process from "node:process";
import { startServer, StartServerSchema } from "../server.mjs";
import { connectToServer } from "./utils/ipc/client.mjs";

const [ppid, payload] = process.argv.slice(-2);

const sendToParent = await connectToServer(+ppid);
const host = await startServer(StartServerSchema.parse(JSON.parse(payload)));

sendToParent?.({ host });
