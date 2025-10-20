/**
 * Configuration interface that defines what actions are allowed for a human interrupt.
 * This controls the available interaction options when the graph is paused for human input.
 *
 * @deprecated Use `HumanInterruptConfig` has been moved to {@link https://www.npmjs.com/package/langchain langchain} package.
 * Update your import to `import { HumanInterruptConfig } from "langchain";`
 *
 * @property {boolean} allow_ignore - Whether the human can choose to ignore/skip the current step
 * @property {boolean} allow_respond - Whether the human can provide a text response/feedback
 * @property {boolean} allow_edit - Whether the human can edit the provided content/state
 * @property {boolean} allow_accept - Whether the human can accept/approve the current state
 */
export interface HumanInterruptConfig {
  allow_ignore: boolean;
  allow_respond: boolean;
  allow_edit: boolean;
  allow_accept: boolean;
}

/**
 * Represents a request for human action within the graph execution.
 * Contains the action type and any associated arguments needed for the action.
 *
 * @deprecated Use `ActionRequest` has been moved to {@link https://www.npmjs.com/package/langchain langchain} package.
 * Update your import to `import { ActionRequest } from "langchain/prebuilt/interrupt";`
 *
 * @property {string} action - The type or name of action being requested (e.g., "Approve XYZ action")
 * @property {Record<string, any>} args - Key-value pairs of arguments needed for the action
 */
export interface ActionRequest {
  action: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
}

/**
 * Represents an interrupt triggered by the graph that requires human intervention.
 * This is passed to the `interrupt` function when execution is paused for human input.
 *
 * @deprecated Use `HumanInterrupt` has been moved to {@link https://www.npmjs.com/package/langchain langchain} package.
 * Update your import to `import { HumanInterrupt } from "langchain/prebuilt/interrupt";`
 *
 * @property {ActionRequest} action_request - The specific action being requested from the human
 * @property {HumanInterruptConfig} config - Configuration defining what actions are allowed
 * @property {string} [description] - Optional detailed description of what input is needed
 */
export interface HumanInterrupt {
  action_request: ActionRequest;
  config: HumanInterruptConfig;
  description?: string;
}

/**
 * The response provided by a human to an interrupt, which is returned when graph execution resumes.
 *
 * @deprecated Use `HumanResponse` has been moved to {@link https://www.npmjs.com/package/langchain langchain} package.
 * Update your import to `import { HumanResponse } from "langchain/prebuilt/interrupt";`
 *
 * @property {("accept"|"ignore"|"response"|"edit")} type - The type of response:
 *   - "accept": Approves the current state without changes
 *   - "ignore": Skips/ignores the current step
 *   - "response": Provides text feedback or instructions
 *   - "edit": Modifies the current state/content
 * @property {null|string|ActionRequest} args - The response payload:
 *   - null: For ignore/accept actions
 *   - string: For text responses
 *   - ActionRequest: For edit actions with updated content
 */
export type HumanResponse = {
  type: "accept" | "ignore" | "response" | "edit";
  args: null | string | ActionRequest;
};
