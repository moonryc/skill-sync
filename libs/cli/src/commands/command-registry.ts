import { Argument, Command, InvalidArgumentError, Option } from 'commander';

import { CONFIG_KEYS } from '../application/config-service.js';
import { INIT_PLAN_FINGERPRINT_PATTERN } from '../application/init-plan.js';
import { INSTALL_PLAN_FINGERPRINT_PATTERN } from '../application/install-plan.js';

export type CommandHelpGroup =
  'diagnostics' | 'discovery' | 'library' | 'lifecycle' | 'project' | 'recovery' | 'setup';

export type CommandScopeSupport = 'managed' | 'none' | 'project';
export type CommandMutationClass = 'mutation' | 'previewable' | 'read-only';
export type CommandInteractivity = 'none' | 'optional' | 'terminal-ui';
export type CommandFreshness = 'cache-or-remote' | 'local' | 'none';
export type CommandHandlerKind = 'completion' | 'executor' | 'terminal-ui' | 'version';

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
export type CommandCompletionValueKind = 'path' | 'value';

export interface CommandArgumentDefinition {
  readonly choices?: readonly string[];
  readonly completion?: CommandCompletionValueKind;
  readonly description: string;
  readonly syntax: string;
}

export interface CommandOptionDefinition {
  readonly choices?: readonly string[];
  readonly completion?: CommandCompletionValueKind;
  readonly conflicts?: readonly string[];
  readonly defaultValue?: unknown;
  readonly description: string;
  readonly flags: string;
  readonly required?: boolean;
  readonly repeatable?: boolean;
}

export type CommandCommonOptionApplicability =
  'all' | 'confirmation' | 'global-scope' | 'json' | 'managed-scope' | 'prompt-control';

export interface CommandCommonOptionDefinition extends CommandOptionDefinition {
  readonly applicability: CommandCommonOptionApplicability;
}

export interface CommandDefinition {
  readonly aliases: readonly string[];
  readonly arguments: readonly CommandArgumentDefinition[];
  readonly choices: readonly string[];
  readonly description: string;
  readonly documentation: string;
  readonly examples: readonly string[];
  readonly freshness: CommandFreshness;
  readonly handler: CommandHandlerKind;
  readonly helpGroup: CommandHelpGroup;
  readonly id: string;
  readonly interactivity: CommandInteractivity;
  readonly mutation: CommandMutationClass;
  readonly options: readonly CommandOptionDefinition[];
  readonly path: readonly string[];
  readonly resultSchema: string;
  readonly safety: string;
  readonly scope: CommandScopeSupport;
}

export interface CommandParentDefinition {
  readonly description: string;
  readonly helpGroup: CommandHelpGroup;
  readonly name: string;
}

export interface CommandHelpDefinition {
  readonly argument: CommandArgumentDefinition;
  readonly description: string;
  readonly name: 'help';
}

const TARGET_CHOICES = ['codex', 'claude'] as const;
const STATE_CHOICES = [
  'not-installed',
  'current',
  'outdated',
  'locally-modified',
  'conflicted',
  'missing',
  'orphaned',
  'unmanaged-collision',
] as const;

export const commandCommonOptionDefinitions = [
  { flags: '--json', description: 'emit one machine-readable result', applicability: 'json' },
  { flags: '--no-color', description: 'disable ANSI styling', applicability: 'all' },
  {
    flags: '--no-input',
    description: 'disable prompts after providing every required choice',
    applicability: 'prompt-control',
  },
  {
    flags: '--yes',
    description: 'confirm an already explicit and reviewed mutation',
    applicability: 'confirmation',
  },
  {
    flags: '--project <path>',
    description: 'use an explicit project root',
    completion: 'path',
    applicability: 'managed-scope',
  },
  {
    flags: '--global',
    description: 'use user-level global skill scope',
    applicability: 'global-scope',
  },
] as const satisfies readonly CommandCommonOptionDefinition[];

const DOCS_ROOT = 'https://github.com/moonryc/skill-sync/blob/main/apps/wiki/src/content/docs';

function docs(page: string, anchor: string): string {
  return `${DOCS_ROOT}/${page}.md#${anchor}`;
}

function argument(
  syntax: string,
  description: string,
  choices?: readonly string[],
  completion?: CommandCompletionValueKind,
): CommandArgumentDefinition {
  return {
    syntax,
    description,
    ...(choices === undefined ? {} : { choices }),
    ...(completion === undefined ? {} : { completion }),
  };
}

function option(
  flags: string,
  description: string,
  extras: Omit<CommandOptionDefinition, 'description' | 'flags'> = {},
): CommandOptionDefinition {
  return { flags, description, ...extras };
}

function define(
  definition: Omit<CommandDefinition, 'aliases' | 'choices' | 'options'> & {
    readonly aliases?: readonly string[];
    readonly choices?: readonly string[];
    readonly options?: readonly CommandOptionDefinition[];
  },
): CommandDefinition {
  return {
    aliases: [],
    choices: [],
    options: [],
    ...definition,
  };
}

export const commandParents = [
  { name: 'config', description: 'Inspect or change non-secret defaults', helpGroup: 'setup' },
  {
    name: 'recovery',
    description: 'Inspect and resolve interrupted operations',
    helpGroup: 'recovery',
  },
  {
    name: 'library',
    description: 'Manage canonical library content',
    helpGroup: 'library',
  },
  { name: 'group', description: 'Manage library groups', helpGroup: 'library' },
] as const satisfies readonly CommandParentDefinition[];

export const commanderProvidedOptionDefinitions = {
  help: {
    flags: '-h, --help',
    description: 'display help for command',
  },
  version: {
    flags: '-V, --version',
    description: 'output the version number',
  },
} as const satisfies Readonly<Record<'help' | 'version', CommandOptionDefinition>>;

export const commandDefinitions = [
  define({
    id: 'version',
    path: ['version'],
    description: 'Print the installed CLI version',
    helpGroup: 'lifecycle',
    scope: 'none',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'local',
    handler: 'version',
    resultSchema: 'cli-version-v1',
    arguments: [],
    examples: ['skill-sync version', 'skill-sync --json version'],
    safety: 'Reads package metadata only; it does not contact the registry or change files.',
    documentation: docs('reference/configuration', 'cli-lifecycle'),
  }),
  define({
    id: 'self-update',
    path: ['self-update'],
    description: 'Update the globally installed CLI with npm',
    helpGroup: 'lifecycle',
    scope: 'none',
    mutation: 'mutation',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'cli-self-update-v1',
    arguments: [],
    examples: ['skill-sync self-update', 'skill-sync --json self-update'],
    safety:
      'Changes the global npm installation. Project and global skill scope flags do not apply.',
    documentation: docs('reference/configuration', 'cli-lifecycle'),
  }),
  define({
    id: 'init',
    path: ['init'],
    description: 'Connect or create the default skill library',
    helpGroup: 'setup',
    scope: 'none',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'library-init-v1',
    arguments: [argument('[url]', 'HTTP(S) or SSH Git repository URL')],
    options: [
      option('--create <owner/name>', 'create a GitHub repository as owner/name'),
      option('--visibility <visibility>', 'repository visibility for --create', {
        choices: ['private', 'public', 'internal'],
      }),
      option('--transport <transport>', 'clone transport for --create', {
        choices: ['https', 'ssh'],
      }),
      option('--branch <branch>', 'library branch'),
      option('--dry-run', 'inspect and validate the exact setup plan without changing anything'),
      option(
        '--expect-plan <fingerprint>',
        'apply only if this exact reviewed setup plan is still current',
        { conflicts: ['dryRun'] },
      ),
    ],
    choices: [
      '--create: a GitHub owner/name repository',
      '--visibility: private (default), public, or internal',
      '--transport: https (default) or ssh',
    ],
    examples: [
      'skill-sync init git@github.com:you/ai-skills.git --dry-run',
      'skill-sync init --create you/ai-skills --visibility private --transport ssh --dry-run',
      'skill-sync init git@github.com:you/ai-skills.git --branch main --expect-plan init-v1-<fingerprint>',
    ],
    safety:
      'Use SSH or a Git credential helper; never put credentials in a remote URL. Interactive use shows the plan before confirmation; without confirmation the command previews only. Use --expect-plan for an exact reviewed apply or --yes for intentional one-command automation.',
    documentation: docs('reference/library-commands', 'init'),
  }),
  define({
    id: 'completion',
    path: ['completion'],
    description: 'Print a shell completion script for skill-sync',
    helpGroup: 'setup',
    scope: 'none',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'local',
    handler: 'completion',
    resultSchema: 'completion-script-v1',
    arguments: [],
    options: [
      option('--shell <shell>', 'shell whose completion script should be generated', {
        choices: COMPLETION_SHELLS,
      }),
    ],
    choices: [`--shell: ${COMPLETION_SHELLS.join(', ')}`],
    examples: [
      'source /dev/stdin <<< "$(skill-sync completion --shell bash)"',
      'autoload -Uz compinit; compinit; source <(skill-sync completion --shell zsh)',
      'skill-sync completion --shell fish | source',
      'skill-sync completion --shell powershell | Out-String | Invoke-Expression',
    ],
    safety:
      'Prints deterministic static completion only; it does not read configuration, inspect recovery state, contact the network, or change shell profiles.',
    documentation: docs('reference/configuration', 'shell-completion'),
  }),
  define({
    id: 'tui',
    path: ['tui'],
    description: 'Open the interactive skill workflow',
    helpGroup: 'discovery',
    scope: 'managed',
    mutation: 'previewable',
    interactivity: 'terminal-ui',
    freshness: 'cache-or-remote',
    handler: 'terminal-ui',
    resultSchema: 'terminal-ui-v1',
    arguments: [],
    examples: ['skill-sync tui', 'skill-sync --project ./my-project tui'],
    safety:
      'Every mutation is reviewed and confirmed; first-run setup offers diagnostics and a guide.',
    documentation: docs('reference/project-commands', 'tui'),
  }),
  define({
    id: 'install',
    path: ['install'],
    description: 'Install skills into this project or global scope',
    helpGroup: 'project',
    scope: 'managed',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'skill-install-v1',
    arguments: [argument('[ids...]', 'qualified skill IDs')],
    options: [
      option('--target <target>', 'target agent: codex or claude (repeatable)', {
        choices: TARGET_CHOICES,
        defaultValue: [],
        repeatable: true,
      }),
      option('--all', 'select every eligible skill'),
      option('--gitignore', 'add exact managed paths to .gitignore'),
      option('--no-gitignore', 'do not manage .gitignore'),
      option('--dry-run', 'preview exact destinations without writes'),
      option(
        '--expect-plan <fingerprint>',
        'apply only if this exact reviewed dry-run plan is still current',
        { conflicts: ['dryRun'] },
      ),
    ],
    choices: ['--target: codex or claude; repeat --target to install for both agents'],
    examples: [
      'skill-sync install frontend/review-ui --target codex --gitignore --dry-run',
      'skill-sync --global install frontend/review-ui --target codex --dry-run',
      'skill-sync install --all --target codex --target claude --dry-run',
    ],
    safety:
      'Install creates new managed copies; it does not update existing ones. Interactive use shows the plan before confirmation; without confirmation the command previews only. Apply a reviewed plan with its printed --expect-plan fingerprint, or use --yes for intentional one-command automation.',
    documentation: docs('reference/project-commands', 'install'),
  }),
  define({
    id: 'adopt',
    path: ['adopt'],
    description: 'Track an exact existing unmanaged skill copy without replacing it',
    helpGroup: 'project',
    scope: 'managed',
    mutation: 'previewable',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'skill-adopt-v1',
    arguments: [argument('<id>', 'exact qualified library skill ID')],
    options: [
      option('--target <target>', 'existing target agent containing the skill', {
        choices: TARGET_CHOICES,
        required: true,
      }),
      option('--dry-run', 'verify adoption without writing tracking state'),
    ],
    choices: ['--target: codex or claude'],
    examples: [
      'skill-sync adopt frontend/review-ui --target codex --dry-run',
      'skill-sync adopt frontend/review-ui --target codex',
    ],
    safety: 'Adopt verifies an exact digest match and never replaces the existing files.',
    documentation: docs('reference/project-commands', 'adopt'),
  }),
  define({
    id: 'sync',
    path: ['sync'],
    description: 'Refresh every tracked skill from the library',
    helpGroup: 'project',
    scope: 'managed',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'skill-reconciliation-v1',
    arguments: [],
    options: [
      option('--check', 'report drift without writes'),
      option('--dry-run', 'preview without writes'),
      option('--discard-local', 'allow replacement of local edits'),
      option('--offline <revision>', 'use an explicit cached revision'),
    ],
    examples: ['skill-sync sync --check', 'skill-sync sync --dry-run', 'skill-sync sync'],
    safety:
      'Local edits are preserved unless --discard-local is explicitly reviewed and confirmed.',
    documentation: docs('reference/project-commands', 'sync'),
  }),
  define({
    id: 'update',
    path: ['update'],
    description: 'Refresh selected tracked skills',
    helpGroup: 'project',
    scope: 'managed',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'skill-reconciliation-v1',
    arguments: [argument('[ids...]', 'qualified tracked skill IDs')],
    options: [
      option('--all', 'refresh every tracked skill'),
      option('--dry-run', 'preview without writes'),
      option('--discard-local', 'allow replacement of local edits'),
      option('--offline <revision>', 'use an explicit cached revision'),
    ],
    examples: [
      'skill-sync update frontend/review-ui --dry-run',
      'skill-sync update frontend/review-ui',
      'skill-sync update --all',
    ],
    safety:
      'Local edits are preserved unless --discard-local is explicitly reviewed and confirmed.',
    documentation: docs('reference/project-commands', 'update'),
  }),
  define({
    id: 'add',
    path: ['add'],
    description: 'Add a new local skill to the library',
    helpGroup: 'library',
    scope: 'none',
    mutation: 'previewable',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'library-add-v1',
    arguments: [argument('<path>', 'local skill directory', undefined, 'path')],
    options: [
      option('--group <group>', 'destination group'),
      option('--dry-run', 'preview without writes'),
    ],
    examples: [
      'skill-sync add ./my-skill --group engineering --dry-run',
      'skill-sync add ./my-skill --group engineering',
    ],
    safety: 'Validates inert skill content before changing the canonical library.',
    documentation: docs('reference/library-commands', 'add'),
  }),
  define({
    id: 'publish',
    path: ['publish'],
    description: 'Publish edits to existing library skills',
    helpGroup: 'library',
    scope: 'project',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'library-publish-v1',
    arguments: [argument('[ids...]', 'qualified tracked skill IDs')],
    options: [
      option('--all', 'publish every eligible modified skill'),
      option('--from <target>', 'explicit source target', { choices: TARGET_CHOICES }),
      option('--dry-run', 'preview without writes'),
    ],
    choices: ['--from: codex or claude'],
    examples: [
      'skill-sync publish frontend/review-ui --from codex --dry-run',
      'skill-sync publish frontend/review-ui --from codex',
    ],
    safety:
      'Review with --dry-run when source copies differ; publish never updates installed copies.',
    documentation: docs('reference/library-commands', 'publish'),
  }),
  define({
    id: 'list',
    path: ['list'],
    description: 'List the grouped skill catalog',
    helpGroup: 'discovery',
    scope: 'managed',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'catalog-list-v1',
    arguments: [],
    options: [
      option('--group <group>', 'group subtree (repeatable)', {
        defaultValue: [],
        repeatable: true,
      }),
      option('--query <text>', 'identifier or description query (repeatable)', {
        defaultValue: [],
        repeatable: true,
      }),
      option('--agent <agent>', 'compatible agent (repeatable)', {
        choices: TARGET_CHOICES,
        defaultValue: [],
        repeatable: true,
      }),
      option('--state <state>', 'installation state (repeatable)', {
        choices: STATE_CHOICES,
        defaultValue: [],
        repeatable: true,
      }),
    ],
    choices: ['--agent: codex or claude', `--state: ${STATE_CHOICES.join(', ')}`],
    examples: [
      'skill-sync list',
      'skill-sync list --query review',
      'skill-sync list --agent codex --state not-installed',
    ],
    safety: 'Read-only; stale cached results are labeled and never described as current.',
    documentation: docs('reference/inspection', 'list'),
  }),
  define({
    id: 'info',
    path: ['info'],
    aliases: ['show'],
    description: 'Inspect one skill without changing it',
    helpGroup: 'discovery',
    scope: 'managed',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'catalog-info-v1',
    arguments: [argument('<id>', 'qualified or unambiguous skill ID')],
    examples: ['skill-sync info frontend/review-ui', 'skill-sync --global info frontend/review-ui'],
    safety: 'Read-only; fetched skill content remains inert data.',
    documentation: docs('reference/inspection', 'info'),
  }),
  define({
    id: 'diff',
    path: ['diff'],
    description: 'Compare a managed skill with recorded and canonical state',
    helpGroup: 'project',
    scope: 'managed',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'skill-diff-v1',
    arguments: [argument('<id>', 'qualified or unambiguous tracked skill ID')],
    examples: ['skill-sync diff frontend/review-ui', 'skill-sync --global diff frontend/review-ui'],
    safety: 'Read-only; it does not run external diff drivers or skill content.',
    documentation: docs('reference/inspection', 'diff'),
  }),
  define({
    id: 'status',
    path: ['status'],
    description: 'Show reconciliation state for managed skills',
    helpGroup: 'project',
    scope: 'managed',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'skill-status-v1',
    arguments: [],
    options: [option('--offline', 'inspect cached state without remote access')],
    examples: ['skill-sync status', 'skill-sync status --offline', 'skill-sync --global status'],
    safety:
      'Read-only; a fresh project reports setup guidance instead of treating absent state as corruption.',
    documentation: docs('reference/inspection', 'status'),
  }),
  define({
    id: 'uninstall',
    path: ['uninstall'],
    description: 'Remove managed project or global copies',
    helpGroup: 'project',
    scope: 'managed',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'skill-uninstall-v1',
    arguments: [argument('[ids...]', 'qualified tracked skill IDs')],
    options: [
      option('--all', 'select every managed skill'),
      option('--discard-local', 'allow removal of local edits'),
      option('--dry-run', 'preview exact removals without writes'),
    ],
    examples: [
      'skill-sync uninstall frontend/review-ui --dry-run',
      'skill-sync uninstall frontend/review-ui',
      'skill-sync uninstall --all --dry-run',
    ],
    safety: 'Local modifications require --discard-local and a recoverable backup before removal.',
    documentation: docs('reference/project-commands', 'uninstall'),
  }),
  define({
    id: 'validate',
    path: ['validate'],
    description: 'Validate a library, skill ID, installed skill, or local path',
    helpGroup: 'diagnostics',
    scope: 'managed',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'validation-report-v1',
    arguments: [argument('[id-or-path]', 'qualified ID or filesystem path', undefined, 'path')],
    examples: [
      'skill-sync validate',
      'skill-sync validate frontend/review-ui',
      'skill-sync validate ./local-skill',
    ],
    safety: 'Read-only; validation treats all inspected content as inert data.',
    documentation: docs('reference/inspection', 'validate'),
  }),
  define({
    id: 'config:path',
    path: ['config', 'path'],
    description: 'Print the active configuration file path',
    helpGroup: 'setup',
    scope: 'none',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'config-path-v1',
    arguments: [],
    examples: ['skill-sync config path'],
    safety: 'Read-only and never prints credentials.',
    documentation: docs('reference/configuration', 'config-path'),
  }),
  define({
    id: 'config:list',
    path: ['config', 'list'],
    description: 'List configured values and their effective sources',
    helpGroup: 'setup',
    scope: 'none',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'config-list-v1',
    arguments: [],
    examples: ['skill-sync config list'],
    safety: 'Read-only and redacts secret-bearing values.',
    documentation: docs('reference/configuration', 'config-list'),
  }),
  ...(['get', 'unset'] as const).map((name) =>
    define({
      id: `config:${name}`,
      path: ['config', name],
      description: `${name === 'get' ? 'Read' : 'Unset'} one configuration value`,
      helpGroup: 'setup',
      scope: 'none',
      mutation: name === 'get' ? 'read-only' : 'mutation',
      interactivity: 'none',
      freshness: 'local',
      handler: 'executor',
      resultSchema: `config-${name}-v1`,
      arguments: [argument('<key>', 'supported configuration key', CONFIG_KEYS)],
      choices: [`key: ${CONFIG_KEYS.join(', ')}`],
      examples: [`skill-sync config ${name} library.branch`],
      safety:
        name === 'get'
          ? 'Read-only; supported configuration values do not contain credentials.'
          : 'Removes the selected override atomically, reports dependent library fields, and does not write for an already-unset key.',
      documentation: docs('reference/configuration', `config-${name}`),
    }),
  ),
  define({
    id: 'config:set',
    path: ['config', 'set'],
    description: 'Set one non-secret configuration value',
    helpGroup: 'setup',
    scope: 'none',
    mutation: 'mutation',
    interactivity: 'none',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'config-set-v1',
    arguments: [
      argument('<key>', 'supported configuration key', CONFIG_KEYS),
      argument('<value>', 'new non-secret value'),
    ],
    choices: [`key: ${CONFIG_KEYS.join(', ')}`],
    examples: [
      'skill-sync config set defaults.targets codex,claude',
      'skill-sync config set defaults.gitignore manage',
    ],
    safety: 'Rejects credential-bearing remotes and writes configuration atomically.',
    documentation: docs('reference/configuration', 'config-set'),
  }),
  define({
    id: 'doctor',
    path: ['doctor'],
    description: 'Diagnose configuration and environment health without mutation',
    helpGroup: 'diagnostics',
    scope: 'managed',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'doctor-report-v1',
    arguments: [],
    options: [option('--offline', 'skip remote checks')],
    examples: [
      'skill-sync doctor',
      'skill-sync doctor --offline',
      'skill-sync --global doctor --offline',
    ],
    safety:
      'Read-only; diagnostics include application recovery evidence, redact credentials, and never repair automatically.',
    documentation: docs('reference/inspection', 'doctor'),
  }),
  define({
    id: 'recovery:list',
    path: ['recovery', 'list'],
    description: 'List unresolved recovery records without changing them',
    helpGroup: 'recovery',
    scope: 'none',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'recovery-list-v1',
    arguments: [],
    options: [
      option('--scope <scope>', 'filter by scope kind, ID, or path'),
      option('--include-terminal', 'include committed and rolled-back journals'),
    ],
    examples: ['skill-sync recovery list', 'skill-sync recovery list --scope project'],
    safety: 'Read-only; use the stable listed ID with recovery inspect before choosing an action.',
    documentation: docs('reference/recovery-commands', 'recovery-list'),
  }),
  define({
    id: 'recovery:inspect',
    path: ['recovery', 'inspect'],
    description: 'Inspect one recovery record without changing it',
    helpGroup: 'recovery',
    scope: 'none',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'recovery-inspect-v1',
    arguments: [argument('<id>', 'stable recovery record ID')],
    examples: ['skill-sync recovery inspect <id>'],
    safety: 'Read-only; inspection reports affected destinations and preview-first next actions.',
    documentation: docs('reference/recovery-commands', 'recovery-inspect'),
  }),
  define({
    id: 'recovery:unlock',
    path: ['recovery', 'unlock'],
    description:
      'Remove one advisory lock after its local owner is gone and the crash grace elapses',
    helpGroup: 'recovery',
    scope: 'none',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'recovery-unlock-v1',
    arguments: [argument('<id>', 'stable advisory lock record ID')],
    options: [option('--dry-run', 'verify abandonment and preview the exact lock removal')],
    examples: [
      'skill-sync recovery unlock <id> --dry-run',
      'skill-sync recovery unlock <id> --yes',
    ],
    safety:
      'Serializes one bounded same-host unlock by stable ID, requires an absent PID plus a 60-second crash grace, and preserves active, foreign, malformed, changed, or ambiguous evidence.',
    documentation: docs('reference/recovery-commands', 'recovery-unlock'),
  }),
  ...(['resume', 'restore'] as const).map((name) =>
    define({
      id: `recovery:${name}`,
      path: ['recovery', name],
      description:
        name === 'resume'
          ? 'Complete an interrupted operation from verified journal evidence'
          : 'Restore the pre-operation state from verified journal evidence',
      helpGroup: 'recovery',
      scope: 'project',
      mutation: 'previewable',
      interactivity: 'optional',
      freshness: 'local',
      handler: 'executor',
      resultSchema: `recovery-${name}-v1`,
      arguments: [argument('<id>', 'stable recovery journal ID')],
      options: [option('--dry-run', 'preview recovery without changing destinations or evidence')],
      examples: [
        `skill-sync recovery ${name} <id> --dry-run`,
        `skill-sync --project /path/to/project recovery ${name} <id>`,
      ],
      safety:
        'Preview first; application revalidates every journaled path and requires confirmation.',
      documentation: docs('reference/recovery-commands', `recovery-${name}`),
    }),
  ),
  define({
    id: 'recovery:prune',
    path: ['recovery', 'prune'],
    description: 'Remove selected terminal recovery records and verified backups',
    helpGroup: 'recovery',
    scope: 'managed',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'local',
    handler: 'executor',
    resultSchema: 'recovery-prune-v1',
    arguments: [argument('<ids...>', 'stable terminal journal or verified backup IDs')],
    options: [option('--dry-run', 'preview exact removals without changing recovery evidence')],
    examples: [
      'skill-sync recovery prune <id> --dry-run',
      'skill-sync --project /path/to/project recovery prune <id>',
    ],
    safety:
      'Only terminal or verified-owned evidence can be pruned; unresolved records are preserved.',
    documentation: docs('reference/recovery-commands', 'recovery-prune'),
  }),
  define({
    id: 'library:remove',
    path: ['library', 'remove'],
    description: 'Delete one canonical library skill',
    helpGroup: 'library',
    scope: 'none',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'library-remove-v1',
    arguments: [argument('<id>', 'exact qualified library skill ID')],
    options: [option('--dry-run', 'preview without writes')],
    examples: [
      'skill-sync library remove frontend/review-ui --dry-run',
      'skill-sync library remove frontend/review-ui',
    ],
    safety:
      'Project copies remain installed as orphans; preview and recover canonical content through Git history.',
    documentation: docs('reference/library-commands', 'library-remove'),
  }),
  define({
    id: 'group:list',
    path: ['group', 'list'],
    description: 'List explicit library groups',
    helpGroup: 'library',
    scope: 'none',
    mutation: 'read-only',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'group-list-v1',
    arguments: [],
    examples: ['skill-sync group list'],
    safety: 'Read-only; it does not change canonical content.',
    documentation: docs('reference/library-commands', 'group-list'),
  }),
  define({
    id: 'group:create',
    path: ['group', 'create'],
    description: 'Create a persistent empty library group',
    helpGroup: 'library',
    scope: 'none',
    mutation: 'mutation',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'group-mutation-v1',
    arguments: [argument('<group>', 'portable group path')],
    examples: ['skill-sync group create engineering'],
    safety: 'Creates only the group marker and refuses invalid or existing paths.',
    documentation: docs('reference/library-commands', 'group-create'),
  }),
  define({
    id: 'group:rename',
    path: ['group', 'rename'],
    description: 'Rename a library group subtree',
    helpGroup: 'library',
    scope: 'none',
    mutation: 'mutation',
    interactivity: 'none',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'group-mutation-v1',
    arguments: [argument('<from>', 'existing group path'), argument('<to>', 'new group path')],
    examples: ['skill-sync group rename engineering platform'],
    safety: 'Qualified skill IDs change; affected projects may temporarily report orphaned IDs.',
    documentation: docs('reference/library-commands', 'group-rename'),
  }),
  define({
    id: 'group:remove',
    path: ['group', 'remove'],
    description: 'Remove an empty group or an explicitly reviewed subtree',
    helpGroup: 'library',
    scope: 'none',
    mutation: 'previewable',
    interactivity: 'optional',
    freshness: 'cache-or-remote',
    handler: 'executor',
    resultSchema: 'group-mutation-v1',
    arguments: [argument('<group>', 'existing group path')],
    options: [
      option('--recursive', 'allow removal of a nonempty group'),
      option('--dry-run', 'preview without writes'),
    ],
    examples: [
      'skill-sync group remove engineering --dry-run',
      'skill-sync group remove engineering --recursive',
    ],
    safety:
      'Nonempty groups require --recursive and confirmation; project copies remain installed as orphans.',
    documentation: docs('reference/library-commands', 'group-remove'),
  }),
] as const satisfies readonly CommandDefinition[];

const definitionsById = new Map(
  commandDefinitions.map((definition) => [definition.id, definition]),
);
const definitionsByPath = new Map(
  commandDefinitions.flatMap((definition) => [
    [definition.path.join(' '), definition] as const,
    ...definition.aliases.map(
      (alias) => [[...definition.path.slice(0, -1), alias].join(' '), definition] as const,
    ),
  ]),
);

export function commandDefinition(id: string): CommandDefinition {
  const definition = definitionsById.get(id);
  if (definition === undefined) throw new Error(`Missing command definition for ${id}.`);
  return definition;
}

function commandOperands(arguments_: readonly string[]): readonly string[] {
  const operands: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === '--project') {
      index += 1;
      continue;
    }
    if (value?.startsWith('--project=') === true) continue;
    if (
      value === '--global' ||
      value === '--json' ||
      value === '--no-color' ||
      value === '--no-input' ||
      value === '--yes'
    ) {
      continue;
    }
    if (value?.startsWith('-') === true) continue;
    if (value !== undefined) operands.push(value);
  }
  return operands;
}

export function requestedCommandId(arguments_: readonly string[]): string {
  const operands = commandOperands(arguments_);
  const first = operands[0];
  if (first === undefined) return 'skill-sync';
  const parent = commandParents.find((candidate) => candidate.name === first);
  if (parent !== undefined) {
    const child = operands[1];
    if (child === undefined) return first;
    return definitionsByPath.get(`${first} ${child}`)?.id ?? `${first}:${child}`;
  }
  return definitionsByPath.get(first)?.id ?? first;
}

function repeat(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function repeatChoice(
  value: string,
  previous: readonly string[],
  choices: readonly string[],
): readonly string[] {
  if (!choices.includes(value)) {
    throw new InvalidArgumentError(
      `Allowed choices are ${choices.map((choice) => JSON.stringify(choice)).join(', ')}.`,
    );
  }
  return repeat(value, previous);
}

export function createOptionFromDefinition(item: CommandOptionDefinition): Option {
  const configured = new Option(item.flags, item.description);
  if (item.choices !== undefined) configured.choices(item.choices);
  if (item.conflicts !== undefined) configured.conflicts([...item.conflicts]);
  if (item.repeatable === true) {
    configured.argParser((value: string, previous: readonly string[]) =>
      item.choices === undefined
        ? repeat(value, previous)
        : repeatChoice(value, previous, item.choices),
    );
  }
  if (item.defaultValue !== undefined) configured.default(item.defaultValue);
  if (item.required === true) configured.makeOptionMandatory();
  return configured;
}

export function createCommandFromDefinition(definition: CommandDefinition): Command {
  const name = definition.path.at(-1);
  if (name === undefined) throw new Error(`Command ${definition.id} has an empty path.`);
  const command = new Command(name).description(definition.description);
  for (const alias of definition.aliases) command.alias(alias);
  for (const item of definition.arguments) {
    const configured = new Argument(item.syntax, item.description);
    if (item.choices !== undefined) configured.choices(item.choices);
    command.addArgument(configured);
  }
  for (const item of definition.options) command.addOption(createOptionFromDefinition(item));
  return command;
}

export function commandDisplayName(definition: CommandDefinition): string {
  return `skill-sync ${definition.path.join(' ')}`;
}

function commonOptionApplies(
  optionDefinition: CommandCommonOptionDefinition,
  definition: CommandDefinition,
): boolean {
  switch (optionDefinition.applicability) {
    case 'all':
      return true;
    case 'json':
      return definition.handler !== 'terminal-ui';
    case 'prompt-control':
      return definition.interactivity === 'optional';
    case 'confirmation':
      return definition.interactivity === 'optional' && definition.mutation !== 'read-only';
    case 'managed-scope':
      return definition.scope === 'managed' || definition.scope === 'project';
    case 'global-scope':
      return definition.scope === 'managed';
  }
}

export function applicableCommonOptionDefinitions(
  definition: CommandDefinition,
): readonly CommandCommonOptionDefinition[] {
  return commandCommonOptionDefinitions.filter((item) => commonOptionApplies(item, definition));
}

export function supportedCommonOptions(definition: CommandDefinition): readonly string[] {
  return applicableCommonOptionDefinitions(definition).map(
    (item) => `${item.flags}: ${item.description}`,
  );
}

export interface CommandValidationIssue {
  readonly code:
    | 'CONFLICTING_OPTIONS'
    | 'CONFLICTING_SCOPE_OPTIONS'
    | 'CONFLICTING_SELECTION'
    | 'INIT_OPTION_REQUIRES_CREATE'
    | 'INVALID_INIT_PLAN_FINGERPRINT'
    | 'INVALID_INSTALL_PLAN_FINGERPRINT'
    | 'OPTION_UNSUPPORTED'
    | 'SCOPE_OPTION_UNSUPPORTED'
    | 'TUI_REQUIRES_INTERACTIVE_MODE';
  readonly message: string;
}

export function validateCommandScope(
  definition: CommandDefinition,
  options: Readonly<Record<string, unknown>>,
): CommandValidationIssue | undefined {
  const project = typeof options.project === 'string' && options.project.length > 0;
  const global = options.global === true;
  if (global && definition.scope !== 'managed') {
    return {
      code: 'SCOPE_OPTION_UNSUPPORTED',
      message: `${commandDisplayName(definition)} does not support --global.${
        definition.scope === 'project' ? ' Use --project <path> for its project context.' : ''
      }`,
    };
  }
  if (project && definition.scope === 'none') {
    return {
      code: 'SCOPE_OPTION_UNSUPPORTED',
      message: `${commandDisplayName(definition)} does not use a project scope; remove --project.`,
    };
  }
  return undefined;
}

function variadicValues(arguments_: readonly unknown[]): readonly string[] {
  const first = arguments_[0];
  if (Array.isArray(first)) {
    return first.filter((entry): entry is string => typeof entry === 'string');
  }
  return arguments_.filter((entry): entry is string => typeof entry === 'string');
}

function rawOptionIsPresent(rawArguments: readonly string[], flag: string): boolean {
  const separator = rawArguments.indexOf('--');
  const optionArguments = separator === -1 ? rawArguments : rawArguments.slice(0, separator);
  return optionArguments.includes(flag);
}

export function validateCommandInvocation(
  definition: CommandDefinition,
  arguments_: readonly unknown[],
  options: Readonly<Record<string, unknown>>,
  rawArguments: readonly string[] = [],
): CommandValidationIssue | undefined {
  if (
    rawOptionIsPresent(rawArguments, '--no-input') &&
    definition.interactivity !== 'optional' &&
    definition.handler !== 'terminal-ui'
  ) {
    return {
      code: 'OPTION_UNSUPPORTED',
      message: `${commandDisplayName(definition)} does not prompt for input; remove --no-input.`,
    };
  }
  if (
    rawOptionIsPresent(rawArguments, '--yes') &&
    (definition.interactivity !== 'optional' || definition.mutation === 'read-only')
  ) {
    return {
      code: 'OPTION_UNSUPPORTED',
      message: `${commandDisplayName(definition)} does not use confirmation prompts; remove --yes.`,
    };
  }
  if (
    options.global === true &&
    typeof options.project === 'string' &&
    options.project.length > 0
  ) {
    return {
      code: 'CONFLICTING_SCOPE_OPTIONS',
      message: 'Pass either --global or --project, not both.',
    };
  }
  const scope = validateCommandScope(definition, options);
  if (scope !== undefined) return scope;

  if (
    ['install', 'publish', 'uninstall', 'update'].includes(definition.id) &&
    options.all === true &&
    variadicValues(arguments_).length > 0
  ) {
    return {
      code: 'CONFLICTING_SELECTION',
      message: `${commandDisplayName(definition)} cannot combine --all with explicit skill IDs.`,
    };
  }

  if (definition.id === 'init') {
    const url = arguments_[0];
    const create = options.create;
    if (typeof url === 'string' && url.length > 0 && typeof create === 'string') {
      return {
        code: 'CONFLICTING_OPTIONS',
        message: 'Pass either a repository URL or --create <owner/name>, not both.',
      };
    }
    if (
      typeof create !== 'string' &&
      (typeof options.transport === 'string' || typeof options.visibility === 'string')
    ) {
      return {
        code: 'INIT_OPTION_REQUIRES_CREATE',
        message: '--transport and --visibility apply only when --create is supplied.',
      };
    }
    if (typeof options.expectPlan === 'string') {
      if (!INIT_PLAN_FINGERPRINT_PATTERN.test(options.expectPlan)) {
        return {
          code: 'INVALID_INIT_PLAN_FINGERPRINT',
          message: '--expect-plan must use the init-v1 fingerprint printed by init --dry-run.',
        };
      }
      if (options.dryRun === true) {
        return {
          code: 'CONFLICTING_OPTIONS',
          message: 'Pass either --dry-run to review a plan or --expect-plan to apply it, not both.',
        };
      }
    }
  }

  if (
    definition.id === 'install' &&
    rawOptionIsPresent(rawArguments, '--gitignore') &&
    rawOptionIsPresent(rawArguments, '--no-gitignore')
  ) {
    return {
      code: 'CONFLICTING_OPTIONS',
      message: 'Pass either --gitignore or --no-gitignore, not both.',
    };
  }

  if (definition.id === 'install' && typeof options.expectPlan === 'string') {
    if (!INSTALL_PLAN_FINGERPRINT_PATTERN.test(options.expectPlan)) {
      return {
        code: 'INVALID_INSTALL_PLAN_FINGERPRINT',
        message: '--expect-plan must use the install-v1 fingerprint printed by install --dry-run.',
      };
    }
    if (options.dryRun === true) {
      return {
        code: 'CONFLICTING_OPTIONS',
        message: 'Pass either --dry-run to review a plan or --expect-plan to apply it, not both.',
      };
    }
  }

  if (definition.handler === 'terminal-ui' && (options.json === true || options.noInput === true)) {
    return {
      code: 'TUI_REQUIRES_INTERACTIVE_MODE',
      message: 'The terminal UI cannot run with --json or --no-input.',
    };
  }
  return undefined;
}

export const topLevelCommandOrder = [
  'version',
  'self-update',
  'init',
  'completion',
  'tui',
  'install',
  'adopt',
  'sync',
  'update',
  'add',
  'publish',
  'list',
  'info',
  'diff',
  'status',
  'uninstall',
  'validate',
  'config',
  'doctor',
  'recovery',
  'library',
  'group',
] as const;

export const commandHelpDefinition = {
  name: 'help',
  description: 'Display help for a command',
  argument: argument('[command]', 'top-level command', topLevelCommandOrder),
} as const satisfies CommandHelpDefinition;
