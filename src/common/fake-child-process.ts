import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly killed: string[] = [];
  input = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.input += chunk.toString();
    });
  }

  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }

  finish(
    output: { stdout?: string; stderr?: string },
    exitCode: number | null,
    signal: string | null = null,
  ) {
    if (output.stdout) this.stdout.emit('data', Buffer.from(output.stdout));
    if (output.stderr) this.stderr.emit('data', Buffer.from(output.stderr));
    this.emit('close', exitCode, signal);
  }
}
