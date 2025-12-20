import { createAgent, tool, humanInTheLoopMiddleware } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

/**
 * A tool that simulates sending an email - requires human approval
 */
export const sendEmail = tool(
  async ({ to, subject, body: _body }) => {
    /**
     * Simulate sending email
     */
    return {
      status: "success",
      content: `Email sent successfully to ${to} with subject "${subject}"`,
    };
  },
  {
    name: "send_email",
    description: "Send an email to a recipient. Requires human approval.",
    schema: z.object({
      to: z.string().describe("The email address to send to"),
      subject: z.string().describe("The email subject line"),
      body: z.string().describe("The email body content"),
    }),
  }
);

/**
 * A tool that simulates deleting a file - requires human approval
 */
export const deleteFile = tool(
  async ({ path }) => {
    /**
     * Simulate file deletion
     */
    return {
      status: "success",
      content: `File "${path}" has been deleted successfully`,
    };
  },
  {
    name: "delete_file",
    description: "Delete a file from the system. Requires human approval.",
    schema: z.object({
      path: z.string().describe("The file path to delete"),
    }),
  }
);

/**
 * A safe tool that doesn't require approval
 */
export const readFile = tool(
  async ({ path }) => {
    /**
     * Simulate reading file content
     */
    const content = `Contents of ${path}:\n---\nThis is example file content for demonstration purposes.`;
    return {
      status: "success",
      content,
    };
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file. Safe operation, no approval needed.",
    schema: z.object({
      path: z.string().describe("The file path to read"),
    }),
  }
);

/**
 * Create a ReAct agent with Human-in-the-Loop middleware.
 *
 * The middleware intercepts tool calls for sensitive operations and
 * pauses execution until human approval is given.
 */
export const agent = createAgent({
  model,
  tools: [sendEmail, deleteFile, readFile],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: {
        /**
         * Email sending requires approval with all options
         */
        send_email: {
          allowedDecisions: ["approve", "edit", "reject"],
          description: "📧 Review email before sending",
        },
        /**
         * File deletion requires approval but no editing
         */
        delete_file: {
          allowedDecisions: ["approve", "reject"],
          description: "🗑️ Confirm file deletion",
        },
        /**
         * Reading files is safe, no approval needed (false = auto-approve)
         */
        read_file: false,
      },
      descriptionPrefix: "Action requires approval",
    }),
  ],
  // Required for HITL - persists state across interrupts
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful assistant that can manage files and send emails.
When asked to send an email, propose one with appropriate subject and body.
When asked to delete files, first try to read them to show the user what will be deleted.
Always be helpful and explain what actions you're about to take.`,
});
