export interface Clock {
  now(): Date;
}

export interface RuntimeIo {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
  setExitCode(code: number): void;
}
