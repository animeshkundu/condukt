import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

import { SubprocessBackend } from '../../runtimes/copilot/subprocess-backend';

function createChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 1234,
  });
}

describe('SubprocessBackend process exit', () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  it('emits error, not idle, when the subprocess is killed by a signal', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    const backend = new SubprocessBackend({
      commandFactory: () => ['copilot', []],
    });
    const session = await backend.createSession({
      model: 'test-model',
      cwd: process.cwd(),
      addDirs: [],
      timeout: 60,
      heartbeatTimeout: 60,
    });
    const onIdle = vi.fn();
    const onError = vi.fn();
    session.on('idle', onIdle);
    session.on('error', onError);

    session.send('test prompt');
    child.emit('close', null, 'SIGKILL');

    expect(onIdle).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toEqual(
      new Error('Process exited code=null signal=SIGKILL'),
    );
  });
});
