export interface RemediationPromptInput {
  mode: string;
  worktreesDir: string;
  branchName: string;
  ticket: unknown;
  action: unknown;
  instruction?: string;
  previousRemediation?: unknown;
  recurrence?: unknown;
}

export function renderRemediationPrompt(
  template: string,
  input: RemediationPromptInput,
): string {
  return template
    .replace('{{MODE}}', input.mode)
    .replace('{{WORKTREES_DIR}}', input.worktreesDir)
    .replace('{{BRANCH_NAME}}', input.branchName)
    .replace('{{TICKET_JSON}}', JSON.stringify(input.ticket, null, 2))
    .replace(
      '{{ENGINEERING_ACTION_JSON}}',
      JSON.stringify(input.action, null, 2),
    )
    .replace(
      '{{REORIENTATION_INSTRUCTION}}',
      input.instruction || '(não é uma reorientação)',
    )
    .replace(
      '{{PREVIOUS_REMEDIATION_JSON}}',
      JSON.stringify(input.previousRemediation || null, null, 2),
    )
    .replace(
      '{{RECURRENCE_JSON}}',
      JSON.stringify(input.recurrence || null, null, 2),
    );
}
