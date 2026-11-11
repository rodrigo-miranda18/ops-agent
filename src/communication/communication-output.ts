export const COMMUNICATION_STATUSES = [
  'READY',
  'INSUFFICIENT_CONTEXT',
] as const;
export type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];

export const PULL_REQUEST_SOURCES = [
  'CITED',
  'DISCOVERED',
  'NOT_FOUND',
] as const;
export type PullRequestSource = (typeof PULL_REQUEST_SOURCES)[number];

export const EVIDENCE_KINDS = ['pull_request', 'commit', 'code'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const LINK_KINDS = ['help_center', 'video', 'reference'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface CommunicationLink {
  kind: LinkKind;
  label: string;
  url: string;
}

export interface CommunicationImage {
  index: number;
  caption: string;
}

export interface CommunicationChange {
  label: string;
  description: string;
}

export interface CommunicationEvidence {
  kind: EvidenceKind;
  reference: string;
  note: string;
}

export interface CommunicationOutput {
  status: CommunicationStatus;
  title: string;
  summary: string;
  changes: CommunicationChange[];
  in_practice: string;
  links: CommunicationLink[];
  images: CommunicationImage[];
  pull_request_source: PullRequestSource;
  evidence: CommunicationEvidence[];
  open_questions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
  field: string,
): T {
  const match = allowed.find((item) => item === value);
  if (match === undefined) {
    throw new Error(`Invalid communication ${field}`);
  }
  return match;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Communication ${field} must be a non-empty string`);
  }
  return value.trim();
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Communication ${field} must be an array`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Communication ${field} must be an object`);
  }
  return value;
}

function parseImages(value: unknown): CommunicationImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const { index, caption } = item;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 1 ||
      typeof caption !== 'string' ||
      !caption.trim()
    )
      return [];
    return [{ index, caption: caption.trim() }];
  });
}

export function parseCommunicationOutput(raw: unknown): CommunicationOutput {
  const output = record(raw, 'output');
  const status = oneOf(COMMUNICATION_STATUSES, output.status, 'status');
  const title = text(output.title, 'title');
  const summary = text(output.summary, 'summary');
  const changes = list(output.changes ?? [], 'changes').map((item, index) => {
    const change = record(item, `changes[${index}]`);
    return {
      label: text(change.label, `changes[${index}].label`),
      description: text(change.description, `changes[${index}].description`),
    };
  });
  const inPractice = text(output.in_practice, 'in_practice');
  const links = list(output.links ?? [], 'links').map((item, index) => {
    const link = record(item, `links[${index}]`);
    const url = text(link.url, `links[${index}].url`);
    if (!/^https:\/\/\S+$/.test(url)) {
      throw new Error(`Communication links[${index}].url must be an https URL`);
    }
    return {
      kind: oneOf(LINK_KINDS, link.kind, `links[${index}].kind`),
      label: text(link.label, `links[${index}].label`),
      url,
    };
  });
  const pullRequestSource = oneOf(
    PULL_REQUEST_SOURCES,
    output.pull_request_source,
    'pull_request_source',
  );
  const evidence = list(output.evidence, 'evidence').map((item, index) => {
    const entry = record(item, `evidence[${index}]`);
    return {
      kind: oneOf(EVIDENCE_KINDS, entry.kind, `evidence[${index}].kind`),
      reference: text(entry.reference, `evidence[${index}].reference`),
      note: text(entry.note, `evidence[${index}].note`),
    };
  });
  const openQuestions = list(output.open_questions, 'open_questions').map(
    (item, index) => text(item, `open_questions[${index}]`),
  );
  return {
    status,
    title,
    summary,
    changes,
    in_practice: inPractice,
    links,
    images: parseImages(output.images),
    pull_request_source: pullRequestSource,
    evidence,
    open_questions: openQuestions,
  };
}
