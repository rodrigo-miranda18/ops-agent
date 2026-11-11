#!/usr/bin/env bash
set -euo pipefail

mkdir -p \
  "${DRIVA_REPOS_DIR:-/app/repos}" \
  /app/state \
  /app/results \
  "${CODEX_HOME:-/app/codex}"

github_auth_mode="${GITHUB_AUTH_MODE:-}"
if [[ -z "$github_auth_mode" && -n "${GH_TOKEN:-}" ]]; then
  github_auth_mode="static"
fi

if [[ "$github_auth_mode" == "static" || "$github_auth_mode" == "app" ]]; then
  git config --global --replace-all url."https://github.com/".insteadOf "git@github.com:"
  git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
  git config --global --replace-all credential.https://github.com.helper \
    "!node /app/dist/github/git-credential-app.js"
fi

if [[ -n "${GIT_AUTHOR_NAME:-}" ]]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
fi

if [[ -n "${GIT_AUTHOR_EMAIL:-}" ]]; then
  git config --global user.email "$GIT_AUTHOR_EMAIL"
fi

exec "$@"
