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
      .from("chat_session_checkpoints")
      .delete()
      .eq("session_id", "6b3cffb2-e521-46e3-9509-266f5380245d");
    await client
      .from("chat_session_writes")
      .delete()
      .neq("session_id", "6b3cffb2-e521-46e3-9509-266f5380245d");
  },
};

export default initializer;
