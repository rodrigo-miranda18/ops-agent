import { describe, expect, it, vi } from 'vitest';
import { parseArgs, printHelp } from './runner-args.js';
import { runnerLogger } from './runner-logger.js';

describe('runner args', () => {
  it('parses execution ownership and resume flags', () => {
    const args = parseArgs([
      '--ticket-id=42',
      '--owner-instance-id=host:uuid',
      '--resume',
    ]);

    expect(args.ownerInstanceId).toBe('host:uuid');
    expect(args.resume).toBe(true);
  });

  it('rejects an empty owner identity', () => {
    expect(() => parseArgs(['--owner-instance-id='])).toThrow(
      '--owner-instance-id must not be empty',
    );
  });

  it('documents the ownership and resume flags', () => {
    const info = vi
      .spyOn(runnerLogger, 'info')
      .mockImplementation(() => undefined);
    printHelp();
    const help = String(info.mock.calls[0]?.[0]);

    expect(help).toContain('--owner-instance-id=ID');
    expect(help).toContain('--resume');
  });
});
