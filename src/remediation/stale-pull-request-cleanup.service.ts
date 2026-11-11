import { Inject, Injectable, Logger } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { GithubService } from '../github/github.service.js';
import { linkedIncidentPullRequestUrls } from '../incidents/incident-pull-request-links.js';
import {
  isStaleIssue,
  issueUrlsFromIncidentIssues,
  staleIssueComment,
} from './stale-issues.js';
import {
  isStalePullRequest,
  pullRequestUrlsFromRemediation,
  stalePullRequestComment,
} from './stale-pull-requests.js';

export interface StalePullRequestCleanupSummary {
  checked: number;
  closed: string[];
  issuesChecked: number;
  issuesClosed: string[];
  failed: number;
}

@Injectable()
export class StalePullRequestCleanupService {
  private readonly logger = new Logger(StalePullRequestCleanupService.name);
  constructor(
    private readonly github: GithubService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
  ) {}

  async cleanup(now = new Date()): Promise<StalePullRequestCleanupSummary> {
    const maxAgeDays = this.config.stalePrMaxAgeDays;
    const urls = await this.agentUrls(
      'remediation.json',
      pullRequestUrlsFromRemediation,
    );
    const issueUrls = await this.agentUrls(
      'github-issues.json',
      issueUrlsFromIncidentIssues,
    );
    const summary: StalePullRequestCleanupSummary = {
      checked: urls.length,
      closed: [],
      issuesChecked: issueUrls.length,
      issuesClosed: [],
      failed: 0,
    };
    for (const url of urls) {
      try {
        const pr = await this.github.viewPullRequest(url);
        if (!isStalePullRequest(pr, now, maxAgeDays)) continue;
        await this.github.closePullRequest(
          url,
          stalePullRequestComment(maxAgeDays),
        );
        summary.closed.push(url);
        this.logger.log(
          `Closed stale pull request ${url} (last activity ${pr.updatedAt})`,
        );
      } catch (error) {
        summary.failed += 1;
        this.logger.warn(
          `Stale pull request check failed for ${url}: ${(error as Error).message}`,
        );
      }
    }
    for (const url of issueUrls) {
      try {
        if (await this.closeIfStaleIssue(url, now))
          summary.issuesClosed.push(url);
      } catch (error) {
        summary.failed += 1;
        this.logger.warn(
          `Stale issue check failed for ${url}: ${(error as Error).message}`,
        );
      }
    }
    return summary;
  }

  private async closeIfStaleIssue(url: string, now: Date): Promise<boolean> {
    const maxAgeDays = this.config.staleIssueMaxAgeDays;
    const issue = await this.github.viewIssue(url);
    if (!isStaleIssue(issue, now, maxAgeDays)) return false;
    for (const pullRequestUrl of linkedIncidentPullRequestUrls(
      issue.commentBodies,
    )) {
      const pr = await this.github.viewPullRequest(pullRequestUrl);
      if (pr.state === 'OPEN') return false;
    }
    await this.github.closeIssue(url, staleIssueComment(maxAgeDays));
    this.logger.log(
      `Closed stale issue ${url} (last activity ${issue.updatedAt})`,
    );
    return true;
  }

  private async agentUrls(
    fileName: string,
    extractUrls: (content: unknown) => string[],
  ): Promise<string[]> {
    const resultsDir = this.runtime.resultsDir;
    let entries: string[];
    try {
      entries = await readdir(resultsDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const urls = new Set<string>();
    for (const entry of entries) {
      if (path.basename(entry) !== fileName) continue;
      const file = path.join(resultsDir, entry);
      try {
        const content: unknown = JSON.parse(await readFile(file, 'utf8'));
        for (const url of extractUrls(content)) urls.add(url);
      } catch (error) {
        this.logger.warn(
          `Skipping unreadable agent result ${file}: ${(error as Error).message}`,
        );
      }
    }
    return [...urls];
  }
}
