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
    content: `Queued an update email to ${to} with subject "${subject}".`,
    email: { to, subject, body },
  }),
  {
    name: "send_release_update_email",
    description:
      "Send a release update email to a stakeholder. Requires human review before dispatch.",
    schema: z.object({
      to: z.string().describe("The recipient email address."),
      subject: z.string().describe("Concise subject line."),
      body: z.string().describe("Email body to review before sending."),
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
  systemPrompt: `You are an assistant that sends release updates on behalf of
the user. When they ask you to announce, email, or notify someone, IMMEDIATELY
call send_release_update_email with a professional subject and body you write
yourself. Default the recipient to "team@example.com" unless the user
specifies one. Never ask clarifying questions first.`,
});
