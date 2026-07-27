export const commandCategories = ['Library', 'Project', 'Inspect', 'Configuration'] as const;

export type CommandCategory = (typeof commandCategories)[number];

export interface WikiCommand {
  readonly name: string;
  readonly summary: string;
  readonly category: CommandCategory;
  readonly href: string;
  readonly keywords: readonly string[];
}

export const commands = [
  {
    name: 'init',
    summary: 'Connect or create the default Git-backed skill library.',
    category: 'Library',
    href: '/reference/library-commands/#init',
    keywords: ['connect', 'create', 'github', 'remote', 'branch'],
  },
  {
    name: 'add',
    summary: 'Validate and add a new local skill to the canonical library.',
    category: 'Library',
    href: '/reference/library-commands/#add',
    keywords: ['new', 'group', 'dry-run', 'canonical'],
  },
  {
    name: 'publish',
    summary: 'Publish edits from managed project copies to existing skills.',
    category: 'Library',
    href: '/reference/library-commands/#publish',
    keywords: ['push', 'from', 'codex', 'claude', 'dry-run'],
  },
  {
    name: 'library remove',
    summary: 'Delete one canonical skill while leaving project copies in place.',
    category: 'Library',
    href: '/reference/library-commands/#library-remove',
    keywords: ['delete', 'orphan', 'confirmation', 'dry-run'],
  },
  {
    name: 'group list',
    summary: 'List explicit groups in the canonical library.',
    category: 'Library',
    href: '/reference/library-commands/#group-list',
    keywords: ['catalog', 'folders'],
  },
  {
    name: 'group create',
    summary: 'Create a persistent empty library group.',
    category: 'Library',
    href: '/reference/library-commands/#group-create',
    keywords: ['marker', 'folder'],
  },
  {
    name: 'group rename',
    summary: 'Move a group subtree and report changed qualified IDs.',
    category: 'Library',
    href: '/reference/library-commands/#group-rename',
    keywords: ['move', 'qualified id'],
  },
  {
    name: 'group remove',
    summary: 'Remove an empty group or explicitly remove a subtree.',
    category: 'Library',
    href: '/reference/library-commands/#group-remove',
    keywords: ['delete', 'recursive', 'confirmation', 'dry-run'],
  },
  {
    name: 'install',
    summary: 'Install selected canonical skills into the current project.',
    category: 'Project',
    href: '/reference/project-commands/#install',
    keywords: ['codex', 'claude', 'target', 'gitignore', 'dry-run'],
  },
  {
    name: 'sync',
    summary: 'Refresh every safely reconcilable tracked skill.',
    category: 'Project',
    href: '/reference/project-commands/#sync',
    keywords: ['update', 'check', 'offline', 'discard-local', 'dry-run'],
  },
  {
    name: 'update',
    summary: 'Refresh selected tracked skills from the library.',
    category: 'Project',
    href: '/reference/project-commands/#update',
    keywords: ['sync', 'offline', 'discard-local', 'dry-run'],
  },
  {
    name: 'uninstall',
    summary: 'Remove selected managed copies from the project.',
    category: 'Project',
    href: '/reference/project-commands/#uninstall',
    keywords: ['remove', 'discard-local', 'all', 'dry-run'],
  },
  {
    name: 'list',
    summary: 'Browse and filter the grouped skill catalog.',
    category: 'Inspect',
    href: '/reference/inspection/#list',
    keywords: ['catalog', 'group', 'query', 'agent', 'state'],
  },
  {
    name: 'info',
    summary: 'Inspect metadata and inventory for one skill.',
    category: 'Inspect',
    href: '/reference/inspection/#info',
    keywords: ['metadata', 'digest', 'revision', 'files'],
  },
  {
    name: 'status',
    summary: 'Classify reconciliation state for managed project copies.',
    category: 'Inspect',
    href: '/reference/inspection/#status',
    keywords: ['current', 'outdated', 'modified', 'conflict', 'offline'],
  },
  {
    name: 'diff',
    summary: 'Compare one project skill with its recorded and canonical state.',
    category: 'Inspect',
    href: '/reference/inspection/#diff',
    keywords: ['changes', 'digest', 'local', 'canonical'],
  },
  {
    name: 'validate',
    summary: 'Validate a library, canonical skill, installed copy, or local path.',
    category: 'Inspect',
    href: '/reference/inspection/#validate',
    keywords: ['schema', 'safety', 'path', 'skill'],
  },
  {
    name: 'doctor',
    summary: 'Run non-mutating environment, Git, config, and state diagnostics.',
    category: 'Inspect',
    href: '/reference/inspection/#doctor',
    keywords: ['diagnose', 'health', 'offline', 'auth', 'cache'],
  },
  {
    name: 'config path',
    summary: 'Print the active user configuration file path.',
    category: 'Configuration',
    href: '/reference/configuration/#config-path',
    keywords: ['settings', 'file'],
  },
  {
    name: 'config list',
    summary: 'List resolved non-secret configuration values and sources.',
    category: 'Configuration',
    href: '/reference/configuration/#config-list',
    keywords: ['settings', 'defaults', 'source'],
  },
  {
    name: 'config get',
    summary: 'Read one supported configuration key.',
    category: 'Configuration',
    href: '/reference/configuration/#config-get',
    keywords: ['settings', 'key'],
  },
  {
    name: 'config set',
    summary: 'Persist one supported non-secret configuration value.',
    category: 'Configuration',
    href: '/reference/configuration/#config-set',
    keywords: ['settings', 'key', 'value'],
  },
  {
    name: 'config unset',
    summary: 'Remove one persisted configuration override.',
    category: 'Configuration',
    href: '/reference/configuration/#config-unset',
    keywords: ['settings', 'key', 'default'],
  },
] as const satisfies readonly WikiCommand[];
