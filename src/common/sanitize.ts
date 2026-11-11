export function sanitize(value: unknown): string {
  return String(value || '')
    .replace(/pk_[A-Za-z0-9_-]+/g, '[REDACTED_CLICKUP_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED_CREDENTIALS]@')
    .replace(/^password=[^\r\n]*$/gim, 'password=[REDACTED]')
    .replace(/Authorization:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]');
}
