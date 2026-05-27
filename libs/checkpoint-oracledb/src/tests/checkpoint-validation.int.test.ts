import { config } from "dotenv";
import oracledb from "oracledb";
import { describe, it } from "vitest";

import {
  specTest,
  type CheckpointSaverTestInitializer,
} from "@langchain/langgraph-checkpoint-validation";
import { OracleCheckpointSaver } from "../saver.js";
import { getOracleCheckpointTables } from "../sql.js";

config();

const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING } = process.env;
const hasOracleCredentials =
  ORACLE_USER && ORACLE_PASSWORD && ORACLE_CONNECT_STRING;

const oracleConnection = {
  user: ORACLE_USER,
  password: ORACLE_PASSWORD,
  connectString: ORACLE_CONNECT_STRING,
};

const saverPrefixes = new WeakMap<OracleCheckpointSaver, string>();

async function dropCheckpointTables(tablePrefix: string): Promise<void> {
  const tables = getOracleCheckpointTables(tablePrefix);
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    for (const tableName of [
      tables.checkpoint_writes,
      tables.checkpoint_blobs,
      tables.checkpoints,
      tables.checkpoint_migrations,
    ]) {
      try {
        await connection.execute(`DROP TABLE ${tableName} PURGE`);
      } catch (error) {
        const code = (error as { errorNum?: number }).errorNum;
        if (code !== 942) throw error;
      }
    }
    await connection.commit();
  } finally {
    await connection.close();
  }
}

const initializer: CheckpointSaverTestInitializer<OracleCheckpointSaver> = {
  checkpointerName: "@oracle/langgraph-oracledb",

  async createCheckpointer() {
    const tablePrefix = `LG_VALID_${Date.now().toString(36).toUpperCase()}_${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}_`;
    const checkpointer = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    await checkpointer.setup();
    saverPrefixes.set(checkpointer, tablePrefix);
    return checkpointer;
  },

  async destroyCheckpointer(checkpointer) {
    const tablePrefix = saverPrefixes.get(checkpointer);
    await checkpointer.end();
    if (tablePrefix) {
      await dropCheckpointTables(tablePrefix);
    }
  },
};

if (hasOracleCredentials) {
  specTest(initializer);
} else {
  describe.skip("@oracle/langgraph-oracledb checkpoint-validation", () => {
    it("skips without Oracle credentials", () => {});
  });
}
