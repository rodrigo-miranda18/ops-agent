import { customFieldValue } from '../clickup/clickup-task.js';
import type { ClickUpTask } from '../clickup/clickup.types.js';

export const COMMUNICATION_SIZES = ['P', 'M', 'G'] as const;
export type CommunicationSize = (typeof COMMUNICATION_SIZES)[number];

const SIZE_FIELD_ID = '00000000-0000-0000-0000-000000000004';
const SIZE_FIELD_NAME = 'Comunicação Cliente';

export function communicationSize(task: ClickUpTask): CommunicationSize | null {
  const value = customFieldValue(task, SIZE_FIELD_ID, SIZE_FIELD_NAME);
  return COMMUNICATION_SIZES.find((size) => size === value) ?? null;
}
