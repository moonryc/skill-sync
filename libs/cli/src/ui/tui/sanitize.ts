// eslint-disable-next-line no-control-regex -- Terminal controls must be neutralized before rendering.
const terminalControlPattern = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Render data as inert terminal text, never as ANSI or other control instructions. */
export function terminalSafe(value: string): string {
  return value.replace(terminalControlPattern, ' ').replace(/\s+/gu, ' ').trim();
}
