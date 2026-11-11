import { Module } from '@nestjs/common';
import { GITHUB_CONFIG, type GitHubConfig } from '../config/github-config.js';
import {
  createGitHubCredentialProvider,
  GITHUB_CREDENTIAL_PROVIDER,
} from './github-credentials.js';
import { GithubService } from './github.service.js';

@Module({
  providers: [
    {
      provide: GITHUB_CREDENTIAL_PROVIDER,
      inject: [GITHUB_CONFIG],
      useFactory: (config: GitHubConfig) =>
        createGitHubCredentialProvider(config),
    },
    GithubService,
  ],
  exports: [GITHUB_CREDENTIAL_PROVIDER, GithubService],
})
export class GithubModule {}
