import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod/v4";

import { model } from "./shared";

const sendReleaseUpdateEmail = tool(
  async ({
    to,
    subject,
    body,
  }: {
    to: string;
    subject: string;
    body: string;
  }) => ({
    status: "queued",
    content: `Queued a protocol update email to ${to} with subject "${subject}".`,
    email: {
      to,
      subject,
      body,
    },
  }),
  {
    name: "send_release_update_email",
    description:
      "Send a release or rollout update email to a stakeholder. Requires human approval before dispatch.",
    schema: z.object({
      to: z.string().describe("The email address to send the update to."),
      subject: z.string().describe("A concise subject line for the message."),
      body: z
        .string()
        .describe("The full email body that should be reviewed before sending."),
    }),
  }
);

const hitlMiddleware = humanInTheLoopMiddleware({
  interruptOn: {
    send_release_update_email: {
      allowedDecisions: ["approve", "edit", "reject"],
      description: "Review the outbound update before the email is sent.",
    },
  },
  descriptionPrefix: "Human review required",
});

export const agent = createAgent({
  model,
  tools: [sendReleaseUpdateEmail],
  middleware: [hitlMiddleware],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful assistant that sends emails on behalf of the user.
When the user asks you to send, notify, email, or announce something, you MUST
immediately call the send_release_update_email tool. Draft a professional subject
and body yourself based on the user's request. Use "team@example.com" as the
default recipient unless the user specifies someone else.
Never ask clarifying questions — just draft and send.`,
});
