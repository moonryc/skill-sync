import { beforeEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => prompts);

import { PromptAdapter, terminalIsInteractive } from '../../src/ui/prompt.js';

describe('prompt policy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('disables prompting in CI and non-TTY contexts', () => {
    expect(terminalIsInteractive(true, true, { CI: '1' })).toBe(false);
    expect(terminalIsInteractive(false, true, {})).toBe(false);
    expect(terminalIsInteractive(true, true, {})).toBe(true);
  });

  it('fails omitted non-interactive input with usage status', async () => {
    const adapter = new PromptAdapter({ interactive: false, noInput: true, yes: false });
    await expect(adapter.text('Skill')).rejects.toMatchObject({
      code: 'MISSING_INPUT',
      exitCode: 2,
    });
  });

  it('does not let yes imply a destructive override', async () => {
    const adapter = new PromptAdapter({ interactive: false, noInput: true, yes: true });
    await expect(adapter.confirm('Delete?', false)).resolves.toBe(false);
    await expect(adapter.confirm('Delete?', true)).resolves.toBe(true);
  });

  it('delegates interactive text, multi-select, and confirmation prompts', async () => {
    prompts.input.mockResolvedValueOnce('https://github.com/acme/skills.git');
    prompts.checkbox.mockResolvedValueOnce(['frontend/review-ui']);
    prompts.confirm.mockResolvedValueOnce(true);
    const adapter = new PromptAdapter({ interactive: true, noInput: false, yes: false });

    await expect(adapter.text('Library URL')).resolves.toBe('https://github.com/acme/skills.git');
    await expect(
      adapter.selectMany('Select skills', [
        {
          name: 'frontend/review-ui',
          value: 'frontend/review-ui',
          description: 'Review UI changes',
        },
      ]),
    ).resolves.toEqual(['frontend/review-ui']);
    await expect(adapter.confirm('Apply the preview?')).resolves.toBe(true);

    expect(prompts.input).toHaveBeenCalledWith({ message: 'Library URL', required: true });
    expect(prompts.checkbox).toHaveBeenCalledWith({
      message: 'Select skills',
      choices: [
        {
          name: 'frontend/review-ui',
          value: 'frontend/review-ui',
          description: 'Review UI changes',
        },
      ],
      pageSize: 15,
      loop: false,
    });
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: 'Apply the preview?',
      default: false,
    });
  });

  it('maps interactive prompt cancellation to the stable cancellation contract', async () => {
    const cancellation = new Error('prompt closed');
    cancellation.name = 'ExitPromptError';
    prompts.checkbox.mockRejectedValueOnce(cancellation);
    const adapter = new PromptAdapter({ interactive: true, noInput: false, yes: false });

    await expect(
      adapter.selectMany('Select skills', [{ name: 'review-ui', value: 'review-ui' }]),
    ).rejects.toMatchObject({ code: 'CANCELLED', exitCode: 130 });
  });
});
