export interface PullRequestStatus {
  url: string;
  state: string;
  updatedAt: string;
}

export interface IssueStatus {
  url: string;
  state: string;
  updatedAt: string;
  assignees: string[];
  commentBodies: string[];
}
