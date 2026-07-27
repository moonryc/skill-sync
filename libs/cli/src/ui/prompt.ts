import { checkbox, confirm, input } from '@inquirer/prompts';

import { EXIT_CODES, SkillSyncError } from '../domain/result.js';

export interface PromptPolicy {
  readonly interactive: boolean;
  readonly noInput: boolean;
  readonly yes: boolean;
}

export function terminalIsInteractive(
  stdinIsTty: boolean,
  stdoutIsTty: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return stdinIsTty && stdoutIsTty && environment.CI === undefined;
}

function asCancellation(error: unknown): never {
  if (error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name)) {
    throw new SkillSyncError('CANCELLED', 'Operation cancelled.', EXIT_CODES.cancelled);
  }
  throw error;
}

export class PromptAdapter {
  constructor(private readonly policy: PromptPolicy) {}

  requireInput(description: string): never {
    throw new SkillSyncError(
      'MISSING_INPUT',
      `${description} must be supplied when prompting is disabled.`,
      EXIT_CODES.usage,
    );
  }

  async text(message: string, requiredDescription = message): Promise<string> {
    if (this.policy.noInput || !this.policy.interactive) this.requireInput(requiredDescription);
    try {
      return await input({ message, required: true });
    } catch (error) {
      return asCancellation(error);
    }
  }

  async selectMany(
    message: string,
    choices: readonly {
      readonly name: string;
      readonly value: string;
      readonly description?: string;
    }[],
    options: { readonly searchable?: boolean } = {},
  ): Promise<readonly string[]> {
    if (this.policy.noInput || !this.policy.interactive) this.requireInput('skill selectors');
    try {
      let visible = [...choices];
      if (options.searchable === true && choices.length > 12) {
        const query = await input({ message: 'Filter skills (leave blank for all)' });
        if (query.trim().length > 0) {
          const normalized = query.toLocaleLowerCase('en-US');
          visible = choices.filter((choice) =>
            `${choice.name} ${choice.description ?? ''}`
              .toLocaleLowerCase('en-US')
              .includes(normalized),
          );
        }
      }
      return await checkbox({ message, choices: visible, pageSize: 15, loop: false });
    } catch (error) {
      return asCancellation(error);
    }
  }

  async confirm(message: string, destructiveOptionPresent = false): Promise<boolean> {
    if (this.policy.yes) return destructiveOptionPresent;
    if (this.policy.noInput || !this.policy.interactive) return false;
    try {
      return await confirm({ message, default: false });
    } catch (error) {
      return asCancellation(error);
    }
  }
}
