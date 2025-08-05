/* eslint-disable import/no-extraneous-dependencies */
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { CheckpointerTestInitializer } from "../types.js";

export const initializer: CheckpointerTestInitializer<SqliteSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-sqlite",

  async createCheckpointer() {
    return SqliteSaver.fromConnString(":memory:");
  },

  async destroyCheckpointer(checkpointer: SqliteSaver) {
    await checkpointer.db.close();
  },
};

export default initializer;
