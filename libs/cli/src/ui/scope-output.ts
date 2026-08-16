export interface ScopedHumanOutputOptions {
  readonly explicitProject?: boolean;
}

/** Build a safe human-facing command without interpolating an untrusted project path. */
export function scopedHumanCommand(
  scope: 'global' | 'project',
  command: string,
  options: ScopedHumanOutputOptions = {},
): string {
  if (scope === 'global') return `skill-sync --global ${command}`;
  return options.explicitProject === true
    ? `skill-sync --project <project-path> ${command}`
    : `skill-sync ${command}`;
}
