// eslint-disable-next-line import/no-extraneous-dependencies
import { SupaSaver } from "@langchain/langgraph-checkpoint-supabase";
import { CheckpointerTestInitializer } from "../types.js";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

export const initializer: CheckpointerTestInitializer<SupaSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-supabase",

  async createCheckpointer() {
    const client = createClient(SUPABASE_URL, SUPABASE_KEY);
    return new SupaSaver(client);
  },

  async afterAll() {
    const client = createClient(SUPABASE_URL, SUPABASE_KEY);
    await client
      .from("langgraph_checkpoints")
      .delete()
    await client
      .from("langgraph_writes")
      .delete()
  },
};

export default initializer;
