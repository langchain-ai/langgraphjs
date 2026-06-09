/**
 * Exercise checkpoint ID generation through the CJS require() graph used by
 * Jest consumers: package entry -> base.cjs -> id.cjs (bundled uuid copies).
 *
 * Importing uuid6 alone from the package entry can succeed while emptyCheckpoint
 * still fails when base.cjs pulls in a broken id.cjs uuid binding.
 */
const { emptyCheckpoint, uuid6, uuid5 } = require(
  "@langchain/langgraph-checkpoint"
);

const checkpoint = emptyCheckpoint();
if (typeof checkpoint.id !== "string" || checkpoint.id.length === 0) {
  throw new Error("emptyCheckpoint() did not produce a checkpoint id");
}

const generated = uuid6(0);
if (typeof generated !== "string" || !/^[0-9a-f-]{36}$/i.test(generated)) {
  throw new Error(`uuid6() returned an invalid id: ${generated}`);
}

const derived = uuid5("task", checkpoint.id);
if (typeof derived !== "string" || !/^[0-9a-f-]{36}$/i.test(derived)) {
  throw new Error(`uuid5() returned an invalid id: ${derived}`);
}

console.log("success");
