export interface PlanningPromptOptions {
  topic?: string;
}

/**
 * Build the kickoff steer prompt for collaborative planning.
 * The planning workflow itself lives in the planning-mode system prompt.
 */
export function buildPlanningPrompt(options: PlanningPromptOptions): string {
  return options.topic
    ? `The user wants to plan: ${options.topic}`
    : "Ask the user what they want to build or accomplish.";
}

/**
 * Build the quick-plan kickoff steer prompt.
 * The detailed quick-planning rules live in the planning-mode system prompt.
 */
export function buildQuickPlanPrompt(description: string): string {
  return `Generate a concise implementation plan for: ${description}. Skip brainstorming — go straight to task breakdown.`;
}
