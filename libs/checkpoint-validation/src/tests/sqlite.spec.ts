import { specTest } from "../spec/index.js";
import { deltaChannelHistoryTests } from "../spec/delta_channel_history.js";
import { initializer } from "./sqlite_initializer.js";

specTest(initializer);
deltaChannelHistoryTests(initializer);
