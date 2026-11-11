export const REORIENTATION_STATUSES = [
  'pending_confirmation',
  'queued',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
] as const;
export type ReorientationStatus = (typeof REORIENTATION_STATUSES)[number];
