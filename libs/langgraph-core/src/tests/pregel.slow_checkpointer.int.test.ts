import { runPregelTests } from "./pregel.test.js";
import { MemorySaverAssertImmutableSlow } from "./utils.js";

runPregelTests(() => new MemorySaverAssertImmutableSlow());
