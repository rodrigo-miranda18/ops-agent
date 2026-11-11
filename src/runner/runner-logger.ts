export interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const runnerLogger: RunnerLogger = {
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};
