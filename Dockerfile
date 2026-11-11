FROM node:24.14.1-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:24.14.1-bookworm-slim AS runtime

ARG APP_UID=10001
ARG APP_GID=10001
ARG NPM_VERSION=11.11.0
ARG CODEX_VERSION=0.146.0
ARG CLAUDE_CODE_VERSION=2.1.316
ARG GH_VERSION=2.96.0
ARG GO_VERSION=1.25.5
ARG PNPM_VERSION=10.33.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      python3 \
      python3-boto3 \
    && architecture="$(dpkg --print-architecture)" \
    && case "$architecture" in \
      amd64) gh_arch="amd64" ;; \
      arm64) gh_arch="arm64" ;; \
      *) echo "Unsupported architecture for GitHub CLI: $architecture" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${gh_arch}.tar.gz" -o /tmp/go.tar.gz \
    && tar -xzf /tmp/go.tar.gz -C /usr/local \
    && ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && npm install --global "npm@${NPM_VERSION}" "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "pnpm@${PNPM_VERSION}" \
    && chmod u+s /usr/bin/bwrap \
    && rm -rf /var/lib/apt/lists/* /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${gh_arch}" \
      /tmp/go.tar.gz \
    && if [ "$APP_UID" = "0" ] || [ "$APP_GID" = "0" ]; then \
      echo "APP_UID and APP_GID must be non-root IDs" >&2; exit 1; \
    fi \
    && existing_group="$(getent group "$APP_GID" | cut -d: -f1 || true)" \
    && if [ -z "$existing_group" ]; then \
      groupadd --gid "$APP_GID" app; \
    elif [ "$existing_group" != "app" ]; then \
      groupmod --new-name app "$existing_group"; \
    fi \
    && existing_user="$(getent passwd "$APP_UID" | cut -d: -f1 || true)" \
    && if [ -z "$existing_user" ]; then \
      useradd --uid "$APP_UID" --gid "$APP_GID" --create-home --home-dir /home/app app; \
    elif [ "$existing_user" != "app" ]; then \
      usermod --login app --home /home/app --move-home "$existing_user"; \
      usermod --gid "$APP_GID" app; \
    fi

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY docker/codex/config.toml /app/codex/config.toml
COPY skills/driva-debug /app/codex/skills/driva-debug
COPY skills/kubernetes-observability-read /app/codex/skills/kubernetes-observability-read
COPY skills/driva-communication /app/codex/skills/driva-communication
COPY docker/entrypoint.sh /usr/local/bin/driva-entrypoint

RUN mkdir -p /app/repos /app/state /app/results /app/secrets /app/codex /app/github-bin \
    && chmod 0755 /app/dist/github/gh-wrapper.js /app/dist/github/git-credential-app.js \
    && ln -s /app/dist/github/gh-wrapper.js /app/github-bin/gh \
    && printf '%s\n' \
      'if [ -n "${DRIVA_REAL_PATH:-}" ]; then' \
      '  export PATH="/app/github-bin:$PATH"' \
      'fi' > /etc/profile.d/driva-github.sh \
    && chown -R app:app /app /home/app \
    && chmod 0755 /usr/local/bin/driva-entrypoint

USER app

ENV NODE_ENV=production \
    HOME=/home/app \
    GOROOT=/usr/local/go \
    PATH=/usr/local/go/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    CODEX_HOME=/app/codex \
    DRIVA_REPOS_DIR=/app/repos \
    CODEX_BIN=/usr/local/bin/codex \
    CLAUDE_BIN=/usr/local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

ENTRYPOINT ["driva-entrypoint"]
CMD ["node", "dist/main.js"]
