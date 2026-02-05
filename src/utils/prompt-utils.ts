/**
 * Prompt utilities for agent modes
 *
 * Agent modes (like 'plan') are implemented via prompt prepending rather than
 * special flags or permission modes. This ensures consistent behavior across
 * all connectors (Claude, Vibe, etc.)
 */

/**
 * Plan mode instruction that gets prepended to the user's prompt.
 * Encourages the agent to plan thoroughly and confirm before implementing.
 */
const PLAN_MODE_INSTRUCTION = `IMPORTANT: Plan thoroughly and confirm your plan with the user before implementing any changes. Focus on analysis and planning first. Do not make any file modifications until the plan is approved.

---

`;

/**
 * Prepends agent mode instructions to a prompt based on the agent mode.
 *
 * @param prompt - The original user prompt
 * @param agentMode - The agent mode ('default' | 'plan')
 * @returns The prompt with any necessary mode instructions prepended
 */
export function applyAgentModeToPrompt(prompt: string, agentMode?: 'default' | 'plan'): string {
  if (agentMode === 'plan') {
    return PLAN_MODE_INSTRUCTION + prompt;
  }
  return prompt;
}

/**
 * Agent mode instruction definitions.
 * In future, this could support more modes with custom prompts.
 */
export const AGENT_MODE_INSTRUCTIONS: Record<string, string> = {
  plan: PLAN_MODE_INSTRUCTION,
};
