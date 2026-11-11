export interface ClickUpFieldOption {
  id?: unknown;
  name?: unknown;
  label?: unknown;
  orderindex?: unknown;
}

export interface ClickUpCustomField {
  id?: unknown;
  name?: unknown;
  value?: unknown;
  type_config?: { options?: ClickUpFieldOption[] };
}

export interface ClickUpReference {
  id?: unknown;
  name?: unknown;
}

export interface ClickUpAttachment {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  url?: string;
  url_w_query?: string;
  external_url?: string;
  mimetype?: string | null;
  size?: unknown;
}

export interface ClickUpTask {
  id: string | number;
  custom_id?: string | null;
  team_id?: string | number | null;
  name?: string;
  description?: string;
  markdown_description?: string;
  url?: string | null;
  status?: string | { status?: string; type?: string } | null;
  date_created?: string | number | null;
  date_updated?: string | number | null;
  priority?: { priority?: string } | null;
  tags?: Array<{ name?: string }>;
  assignees?: Array<{ id?: unknown; username?: string }>;
  list?: ClickUpReference | null;
  folder?: ClickUpReference | null;
  space?: ClickUpReference | null;
  custom_fields?: ClickUpCustomField[];
  custom_item_id?: string | number | null;
  custom_item?: unknown;
  task_type?: unknown;
  type?: unknown;
  attachments?: unknown;
}

export interface ClickUpComment {
  id?: unknown;
  user?: { username?: string; email?: string } | null;
  comment_text?: unknown;
  comment?: unknown;
  date?: unknown;
  resolved?: boolean | null;
}

export interface TicketComment {
  id: string;
  author: string | null;
  text: string;
  created_at: string | null;
  resolved: boolean | null;
}

export interface TicketFields {
  taskType: string | null;
  taskTypeId: string | null;
  ticketType: unknown;
  area: unknown;
  vectors: string[];
}

export interface AttachmentMetadata {
  id: string;
  filename: string;
  mimetype: string | null;
  size: number | null;
  local_path: string | null;
  image_context: boolean;
  status: 'skipped' | 'downloaded' | 'error';
  error: string | null;
}
