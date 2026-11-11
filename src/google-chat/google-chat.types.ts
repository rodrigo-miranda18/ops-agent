import type { RemediationMode } from '../diagnosis/diagnosis-run.js';

export interface ApprovalRecord {
  id: string;
  taskId: string;
  taskUpdatedAt: string;
  ticketName: string;
  ticketUrl: string | null;
  commentPath: string;
  commentHash: string;
  allowedSpaces: string[];
  status: 'pending' | 'approved';
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  clickupCommentId?: string | null;
  assumedAt?: string;
  assumedBy?: string;
  assumedByEmail?: string;
}

export interface ChatEvent {
  type?: string;
  authorizationEventObject?: { systemIdToken?: string };
  commonEventObject?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
    userLocale?: string;
  };
  action?: {
    actionMethodName?: string;
    parameters?: Array<{ key: string; value: string }>;
  };
  space?: { name?: string; type?: string };
  user?: { name?: string; displayName?: string; email?: string };
  message?: {
    name?: string;
    text?: string;
    argumentText?: string;
    sender?: { name?: string; displayName?: string; email?: string };
    thread?: { name?: string };
    quotedMessageMetadata?: { name?: string };
    slashCommand?: { commandId?: string | number };
  };
  chat?: {
    user?: { name?: string; displayName?: string; email?: string };
    space?: { name?: string; type?: string };
    messagePayload?: {
      message?: ChatEvent['message'];
      space?: ChatEvent['space'];
    };
    appCommandPayload?: {
      message?: ChatEvent['message'];
      space?: ChatEvent['space'];
      appCommandMetadata?: {
        appCommandId?: string | number;
        appCommandType?: string;
      };
    };
    buttonClickedPayload?: {
      message?: ChatEvent['message'];
      space?: ChatEvent['space'];
      isDialogEvent?: boolean;
      dialogEventType?: string;
    };
    addedToSpacePayload?: { space?: ChatEvent['space'] };
    removedFromSpacePayload?: { space?: ChatEvent['space'] };
  };
}

export interface IncidentIssueAssignment {
  repository?: string;
  url: string;
  status: 'assigned' | 'failed';
  error?: string;
}

export interface IncidentAssumptionRecord {
  id: string;
  incidentId: string;
  incidentUpdatedAt: string;
  incidentName: string;
  allowedSpaces: string[];
  issues: Array<{ repository?: string; url: string }>;
  status: 'pending' | 'assumed';
  createdAt: string;
  assumedAt?: string;
  assumedBy?: string;
  assumedByEmail?: string;
  assumedByGithub?: string;
  githubAssignments?: IncidentIssueAssignment[];
}

export interface NotificationRecord {
  status: 'pending' | 'sent' | 'failed';
  approvalId: string;
  attempts: number;
  lastAttemptAt: string;
  sentAt?: string;
  messageName?: string | null;
  threadName?: string;
  lastError?: string;
}

export type NotificationState = Record<string, NotificationRecord>;
export type ApprovalState = Record<string, ApprovalRecord>;

export interface AssumptionNotificationRecord {
  status: 'pending' | 'sent' | 'failed';
  approvalId: string;
  taskId: string;
  space: string;
  text: string;
  attempts: number;
  lastAttemptAt?: string;
  sentAt?: string;
  messageName?: string | null;
  threadName?: string;
  threadKey?: string;
  lastError?: string;
}

export type AssumptionNotificationState = Record<
  string,
  AssumptionNotificationRecord
>;

export type IncidentAssumptionState = Record<string, IncidentAssumptionRecord>;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface TicketThreadRecord {
  space: string;
  threadName?: string;
  threadKey: string;
  taskId: string;
  ticketName: string;
  ticketUrl: string | null;
  approvalId?: string;
  remediationMessageName?: string;
  createdAt: string;
  lastActiveAt: string;
  history: ConversationTurn[];
}

export type TicketThreadState = Record<string, TicketThreadRecord>;

export interface StoredRun {
  ticket_id: string;
  updated_at: string;
  finished_at: string;
  status: string;
  classification: string | null;
  diagnosed_vector?: string | null;
  notify?: boolean;
  google_chat_space?: string;
  google_chat_user?: string;
  google_chat_thread?: string;
  notification_version?: number;
  remediation_mode?: RemediationMode;
  remediation_iteration?: number;
  remediation_broadcast_to_bound_threads?: boolean;
}

export interface EngineeringAction {
  decision: string;
  confidence: string;
  summary: string;
  reason: string;
  repositories: Array<
    string | { name?: string; role?: string; scope?: string }
  >;
  repository_gate?: string;
  repository_gate_reason?: string;
}

export interface RemediationResult {
  status: string;
  summary: string;
  reason: string;
  repositories?: Array<{ name?: string; changes?: string }>;
  checks?: Array<{ repository?: string; command?: string; status?: string }>;
  pull_requests?: Array<{
    repository?: string;
    url?: string;
    depends_on?: string[];
  }>;
  superseded_pull_requests?: Array<{
    repository?: string;
    url?: string;
    status?: string;
    reason?: string;
  }>;
}

export interface StoredTicket {
  task_type?: string;
  id: string;
  updated_at?: string;
  custom_id?: string | null;
  name: string;
  description?: string;
  url: string | null;
  vectors?: string[];
  github_issue?: IncidentIssue;
  github_issues?: IncidentIssue[];
  incident?: {
    status?: string;
    severity?: string;
    startedAt?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    generatorURL?: string;
  };
}

export interface IncidentIssue {
  url?: string;
  reused?: boolean;
  repository?: string;
  name?: string;
  role?: string | null;
  scope?: string | null;
}
