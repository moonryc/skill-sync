import {
  applicableCommonOptionDefinitions,
  commandCommonOptionDefinitions,
  commandDefinitions,
  commandHelpDefinition,
  commandParents,
  commanderProvidedOptionDefinitions,
  topLevelCommandOrder,
  type CommandDefinition,
  type CommandOptionDefinition,
  type CompletionShell,
} from './command-registry.js';

export interface CompletionCandidate {
  readonly description: string;
  readonly value: string;
}

export interface CompletionOption {
  readonly choices: readonly string[];
  readonly description: string;
  readonly flags: readonly string[];
  readonly takesValue: boolean;
  readonly valueKind: CompletionValueKind;
}

export type CompletionValueKind = 'choices' | 'none' | 'path' | 'value';

export interface CompletionContext {
  readonly candidates: readonly CompletionCandidate[];
  readonly options: readonly CompletionOption[];
  readonly path: string;
  readonly positionalChoices: Readonly<Record<number, readonly string[]>>;
  readonly positionalValueKinds: Readonly<Record<number, CompletionValueKind>>;
}

export interface CompletionModel {
  readonly contexts: readonly CompletionContext[];
  readonly parents: readonly string[];
  readonly rootCandidates: readonly CompletionCandidate[];
  readonly rootOptions: readonly CompletionOption[];
}

const OPTION_FLAG_PATTERN = /-{1,2}[a-zA-Z][\w-]*/gu;

function optionFlags(flags: string): readonly string[] {
  return flags.match(OPTION_FLAG_PATTERN) ?? [];
}

function normalizeOption(definition: CommandOptionDefinition): CompletionOption {
  const choices = definition.choices ?? [];
  const takesValue = /(?:<[^>]+>|\[[^\]]+\])/u.test(definition.flags);
  return {
    flags: optionFlags(definition.flags),
    description: definition.description,
    choices,
    takesValue,
    valueKind: takesValue
      ? choices.length > 0
        ? 'choices'
        : (definition.completion ?? 'value')
      : 'none',
  };
}

function dedupeCandidates(
  candidates: readonly CompletionCandidate[],
): readonly CompletionCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}

function dedupeOptions(options: readonly CompletionOption[]): readonly CompletionOption[] {
  const seen = new Set<string>();
  return options.filter((item) => {
    const key = item.flags.join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionCandidates(options: readonly CompletionOption[]): readonly CompletionCandidate[] {
  return options.flatMap((item) =>
    item.flags.map((flag) => ({ value: flag, description: item.description })),
  );
}

function completionOptions(definition: CommandDefinition): readonly CompletionOption[] {
  return dedupeOptions([
    ...definition.options.map(normalizeOption),
    ...applicableCommonOptionDefinitions(definition).map(normalizeOption),
    normalizeOption(commanderProvidedOptionDefinitions.help),
  ]);
}

function parentOptions(parent: string): readonly CompletionOption[] {
  const childDefinitions = commandDefinitions.filter(
    (definition) => definition.path.length === 2 && definition.path[0] === parent,
  );
  return dedupeOptions([
    ...childDefinitions.flatMap((definition) =>
      applicableCommonOptionDefinitions(definition).map(normalizeOption),
    ),
    normalizeOption(commanderProvidedOptionDefinitions.help),
  ]);
}

function topLevelCandidate(name: string): CompletionCandidate {
  const definition = commandDefinitions.find(
    (candidate) => candidate.path.length === 1 && candidate.path[0] === name,
  );
  if (definition !== undefined) return { value: name, description: definition.description };
  const parent = commandParents.find((candidate) => candidate.name === name);
  if (parent !== undefined) return { value: name, description: parent.description };
  throw new Error(`Missing completion metadata for top-level command ${name}.`);
}

export function buildCompletionModel(): CompletionModel {
  const rootOptions = dedupeOptions([
    ...commandCommonOptionDefinitions.map(normalizeOption),
    normalizeOption(commanderProvidedOptionDefinitions.help),
    normalizeOption(commanderProvidedOptionDefinitions.version),
  ]);
  const rootCandidates = dedupeCandidates([
    ...topLevelCommandOrder.flatMap((name) => {
      const candidate = topLevelCandidate(name);
      const definition = commandDefinitions.find(
        (item) => item.path.length === 1 && item.path[0] === name,
      );
      return [
        candidate,
        ...(definition?.aliases.map((alias) => ({
          value: alias,
          description: definition.description,
        })) ?? []),
      ];
    }),
    { value: commandHelpDefinition.name, description: commandHelpDefinition.description },
    ...optionCandidates(rootOptions),
  ]);

  const parentContexts = commandParents.map((parent): CompletionContext => {
    const options = parentOptions(parent.name);
    const children = commandDefinitions
      .filter((definition) => definition.path.length === 2 && definition.path[0] === parent.name)
      .flatMap((definition) => [
        { value: definition.path[1] ?? '', description: definition.description },
        ...definition.aliases.map((alias) => ({
          value: alias,
          description: definition.description,
        })),
      ]);
    return {
      path: parent.name,
      options,
      candidates: dedupeCandidates([...children, ...optionCandidates(options)]),
      positionalChoices: {},
      positionalValueKinds: {},
    };
  });

  const leafContexts = commandDefinitions.map((definition): CompletionContext => {
    const options = completionOptions(definition);
    return {
      path: definition.path.join(' '),
      options,
      candidates: optionCandidates(options),
      positionalChoices: Object.fromEntries(
        definition.arguments.flatMap((item, index) =>
          item.choices === undefined ? [] : [[index, item.choices] as const],
        ),
      ),
      positionalValueKinds: Object.fromEntries(
        definition.arguments.map((item, index) => [
          index,
          item.choices === undefined ? (item.completion ?? 'value') : 'choices',
        ]),
      ),
    };
  });

  const helpOptions = [normalizeOption(commanderProvidedOptionDefinitions.help)];
  const helpContext: CompletionContext = {
    path: commandHelpDefinition.name,
    options: helpOptions,
    candidates: optionCandidates(helpOptions),
    positionalChoices: { 0: commandHelpDefinition.argument.choices ?? [] },
    positionalValueKinds: { 0: 'choices' },
  };

  return {
    rootCandidates,
    rootOptions,
    parents: commandParents.map((parent) => parent.name),
    contexts: [...parentContexts, ...leafContexts, helpContext],
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fishQuote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function shellWords(values: readonly string[]): string {
  return shellQuote(values.join(' '));
}

function uniqueValues(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function commandPathCases(model: CompletionModel): readonly string[] {
  const indent = '        ';
  return commandDefinitions
    .filter((definition) => definition.path.length === 1)
    .flatMap((definition) => [
      `${indent}${definition.path[0] ?? ''}) path=${shellQuote(definition.path.join(' '))}; command_end=$((i + 1)) ;;`,
      ...definition.aliases.map(
        (alias) =>
          `${indent}${alias}) path=${shellQuote(definition.path.join(' '))}; command_end=$((i + 1)) ;;`,
      ),
    ])
    .concat(
      model.parents.map(
        (parent) => `${indent}${parent}) path=${shellQuote(parent)}; command_end=$((i + 1)) ;;`,
      ),
      [
        `${indent}${commandHelpDefinition.name}) path=${shellQuote(commandHelpDefinition.name)}; command_end=$((i + 1)) ;;`,
      ],
    );
}

function childPathCases(): readonly string[] {
  return commandDefinitions
    .filter((definition) => definition.path.length === 2)
    .flatMap((definition) => {
      const parent = definition.path[0] ?? '';
      const child = definition.path[1] ?? '';
      return [
        `        ${shellQuote(`${parent}:${child}`)}) path=${shellQuote(definition.path.join(' '))}; command_end=$((i + 1)) ;;`,
        ...definition.aliases.map(
          (alias) =>
            `        ${shellQuote(`${parent}:${alias}`)}) path=${shellQuote(definition.path.join(' '))}; command_end=$((i + 1)) ;;`,
        ),
      ];
    });
}

function optionValueKeys(model: CompletionModel): readonly string[] {
  return uniqueValues([
    ...model.rootOptions
      .filter((item) => item.takesValue)
      .flatMap((item) => item.flags.map((flag) => `:${flag}`)),
    ...model.contexts.flatMap((context) =>
      context.options
        .filter((item) => item.takesValue)
        .flatMap((item) => item.flags.map((flag) => `${context.path}:${flag}`)),
    ),
  ]);
}

function optionChoiceEntries(
  model: CompletionModel,
): readonly { readonly key: string; readonly values: readonly string[] }[] {
  return model.contexts.flatMap((context) =>
    context.options.flatMap((item) =>
      item.choices.length === 0
        ? []
        : item.flags.map((flag) => ({ key: `${context.path}:${flag}`, values: item.choices })),
    ),
  );
}

function optionValueKindEntries(
  model: CompletionModel,
): readonly { readonly key: string; readonly kind: CompletionValueKind }[] {
  return [
    ...model.rootOptions.flatMap((item) =>
      item.takesValue ? item.flags.map((flag) => ({ key: `:${flag}`, kind: item.valueKind })) : [],
    ),
    ...model.contexts.flatMap((context) =>
      context.options.flatMap((item) =>
        item.takesValue
          ? item.flags.map((flag) => ({ key: `${context.path}:${flag}`, kind: item.valueKind }))
          : [],
      ),
    ),
  ];
}

function positionalChoiceEntries(
  model: CompletionModel,
): readonly { readonly key: string; readonly values: readonly string[] }[] {
  return model.contexts.flatMap((context) =>
    Object.entries(context.positionalChoices).map(([index, values]) => ({
      key: `${context.path}:${index}`,
      values,
    })),
  );
}

function positionalValueKindEntries(
  model: CompletionModel,
): readonly { readonly key: string; readonly kind: CompletionValueKind }[] {
  return model.contexts.flatMap((context) =>
    Object.entries(context.positionalValueKinds).map(([index, kind]) => ({
      key: `${context.path}:${index}`,
      kind,
    })),
  );
}

function contextCandidateEntries(
  model: CompletionModel,
): readonly { readonly key: string; readonly values: readonly string[] }[] {
  return [
    { key: '', values: model.rootCandidates.map((candidate) => candidate.value) },
    ...model.contexts.map((context) => ({
      key: context.path,
      values: context.candidates.map((candidate) => candidate.value),
    })),
  ];
}

function bashScript(model: CompletionModel): string {
  const parentPattern = model.parents.map(shellQuote).join('|');
  const takesValuePattern = optionValueKeys(model).map(shellQuote).join('|');
  const optionChoices = optionChoiceEntries(model)
    .map(
      ({ key, values }) =>
        `    ${shellQuote(key)}) COMPREPLY=( $(compgen -W ${shellWords(values)} -- "$cur") ); return 0 ;;`,
    )
    .join('\n');
  const equalsChoices = optionChoiceEntries(model)
    .map(
      ({ key, values }) =>
        `    ${shellQuote(key)}) local value_prefix="\${cur#*=}"; COMPREPLY=( $(compgen -W ${shellWords(
          values,
        )} -- "$value_prefix") ); COMPREPLY=( "\${COMPREPLY[@]/#/\${cur%%=*}=}" ); return 0 ;;`,
    )
    .join('\n');
  const optionPaths = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'path')
    .map(
      ({ key }) =>
        `    ${shellQuote(key)}) _skill_sync_complete_directories "$cur" ""; return 0 ;;`,
    )
    .join('\n');
  const optionValues = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'value')
    .map(({ key }) => `    ${shellQuote(key)}) return 0 ;;`)
    .join('\n');
  const equalsPaths = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'path')
    .map(
      ({ key }) =>
        `      ${shellQuote(key)}) local value_prefix="\${cur#*=}"; _skill_sync_complete_directories "$value_prefix" "\${cur%%=*}="; return 0 ;;`,
    )
    .join('\n');
  const equalsValues = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'value')
    .map(({ key }) => `      ${shellQuote(key)}) return 0 ;;`)
    .join('\n');
  const positionalChoices = positionalChoiceEntries(model)
    .map(
      ({ key, values }) =>
        `      ${shellQuote(key)}) COMPREPLY=( $(compgen -W ${shellWords(values)} -- "$cur") ); return 0 ;;`,
    )
    .join('\n');
  const positionalPaths = positionalValueKindEntries(model)
    .filter((entry) => entry.kind === 'path')
    .map(
      ({ key }) =>
        `      ${shellQuote(key)}) _skill_sync_complete_directories "$cur" ""; return 0 ;;`,
    )
    .join('\n');
  const positionalValues = positionalValueKindEntries(model)
    .filter((entry) => entry.kind === 'value')
    .map(({ key }) => `      ${shellQuote(key)}) return 0 ;;`)
    .join('\n');
  const contextCandidates = contextCandidateEntries(model)
    .map(
      ({ key, values }) =>
        `    ${shellQuote(key)}) COMPREPLY=( $(compgen -W ${shellWords(values)} -- "$cur") ) ;;`,
    )
    .join('\n');

  return [
    '# Bash completion for skill-sync. Generated from the typed command registry.',
    '_skill_sync_is_parent() {',
    '  case "$1" in',
    `    ${parentPattern}) return 0 ;;`,
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '_skill_sync_option_takes_value() {',
    '  case "$1:$2" in',
    `    ${takesValuePattern}) return 0 ;;`,
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '_skill_sync_complete_directories() {',
    '  local value="$1" prefix="$2" candidate',
    '  COMPREPLY=()',
    '  while IFS= read -r candidate; do',
    '    COMPREPLY+=("${prefix}${candidate}")',
    '  done < <(compgen -d -- "$value")',
    '}',
    '',
    '_skill_sync() {',
    '  local cur prev path word i command_end skip_next positional_index after_separator command_search_stopped',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev=""',
    '  if (( COMP_CWORD > 0 )); then prev="${COMP_WORDS[COMP_CWORD - 1]}"; fi',
    '  path=""',
    '  command_end=1',
    '  skip_next=0',
    '  command_search_stopped=0',
    '',
    '  for (( i = 1; i < COMP_CWORD; i++ )); do',
    '    word="${COMP_WORDS[i]}"',
    '    if (( skip_next == 1 )); then skip_next=0; continue; fi',
    '    if [[ "$word" == -- ]]; then command_search_stopped=1; continue; fi',
    '    if (( command_search_stopped == 1 )); then continue; fi',
    '    if [[ "$word" == --project ]]; then skip_next=1; continue; fi',
    '    if [[ "$word" == --project=* || "$word" == --* ]]; then continue; fi',
    '    if [[ -z "$path" ]]; then',
    '      case "$word" in',
    ...commandPathCases(model),
    '      esac',
    '      continue',
    '    fi',
    '    if _skill_sync_is_parent "$path"; then',
    '      case "$path:$word" in',
    ...childPathCases(),
    '      esac',
    '    fi',
    '  done',
    '',
    '  if [[ -z "$path" ]] && (( command_search_stopped == 1 )); then return 0; fi',
    '',
    '  positional_index=0',
    '  skip_next=0',
    '  after_separator=0',
    '  for (( i = command_end; i < COMP_CWORD; i++ )); do',
    '    word="${COMP_WORDS[i]}"',
    '    if (( skip_next == 1 )); then skip_next=0; continue; fi',
    '    if (( after_separator == 0 )) && [[ "$word" == -- ]]; then after_separator=1; continue; fi',
    '    if (( after_separator == 0 )) && [[ "$word" == --*=* ]]; then continue; fi',
    '    if (( after_separator == 0 )) && [[ "$word" == -* ]]; then',
    '      if _skill_sync_option_takes_value "$path" "$word"; then skip_next=1; fi',
    '      continue',
    '    fi',
    '    positional_index=$((positional_index + 1))',
    '  done',
    '',
    '  if (( after_separator == 0 )); then',
    '    case "$path:$prev" in',
    optionChoices,
    optionPaths,
    optionValues,
    '    esac',
    '    if [[ "$cur" == --*=* ]]; then',
    '      case "$path:${cur%%=*}" in',
    equalsChoices,
    equalsPaths,
    equalsValues,
    '      esac',
    '    fi',
    '  fi',
    '',
    '  if [[ "$cur" != -* ]] || (( after_separator == 1 )); then',
    '    case "$path:$positional_index" in',
    positionalChoices,
    positionalPaths,
    positionalValues,
    '    esac',
    '  fi',
    '',
    '  if (( after_separator == 1 )); then return 0; fi',
    '',
    '  case "$path" in',
    contextCandidates,
    '  esac',
    '}',
    '',
    'complete -o filenames -F _skill_sync skill-sync',
  ].join('\n');
}

function zshArray(values: readonly string[]): string {
  return values.map(shellQuote).join(' ');
}

function zshScript(model: CompletionModel): string {
  const parentPattern = model.parents.map(shellQuote).join('|');
  const takesValuePattern = optionValueKeys(model).map(shellQuote).join('|');
  const optionChoices = optionChoiceEntries(model)
    .map(
      ({ key, values }) => `    ${shellQuote(key)}) compadd -Q -- ${zshArray(values)}; return 0 ;;`,
    )
    .join('\n');
  const equalsChoices = optionChoiceEntries(model)
    .map(({ key, values }) => {
      const flag = key.slice(key.lastIndexOf(':') + 1);
      return `      ${shellQuote(key)}) compadd -Q -- ${zshArray(values.map((value) => `${flag}=${value}`))}; return 0 ;;`;
    })
    .join('\n');
  const optionPaths = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'path')
    .map(({ key }) => `    ${shellQuote(key)}) _directories; return 0 ;;`)
    .join('\n');
  const optionValues = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'value')
    .map(({ key }) => `    ${shellQuote(key)}) return 0 ;;`)
    .join('\n');
  const equalsPaths = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'path')
    .map(
      ({ key }) =>
        `      ${shellQuote(key)}) local option_prefix="\${cur%%=*}="; compset -P "\${#option_prefix}"; _directories; return 0 ;;`,
    )
    .join('\n');
  const equalsValues = optionValueKindEntries(model)
    .filter((entry) => entry.kind === 'value')
    .map(({ key }) => `      ${shellQuote(key)}) return 0 ;;`)
    .join('\n');
  const positionalChoices = positionalChoiceEntries(model)
    .map(
      ({ key, values }) =>
        `      ${shellQuote(key)}) compadd -Q -- ${zshArray(values)}; return 0 ;;`,
    )
    .join('\n');
  const positionalPaths = positionalValueKindEntries(model)
    .filter((entry) => entry.kind === 'path')
    .map(({ key }) => `      ${shellQuote(key)}) _directories; return 0 ;;`)
    .join('\n');
  const positionalValues = positionalValueKindEntries(model)
    .filter((entry) => entry.kind === 'value')
    .map(({ key }) => `      ${shellQuote(key)}) return 0 ;;`)
    .join('\n');
  const contextCandidates = contextCandidateEntries(model)
    .map(({ key, values }) => `    ${shellQuote(key)}) candidates=( ${zshArray(values)} ) ;;`)
    .join('\n');

  return [
    '#compdef skill-sync',
    '# Zsh completion for skill-sync. Generated from the typed command registry.',
    '_skill_sync_is_parent() {',
    '  case "$1" in',
    `    ${parentPattern}) return 0 ;;`,
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '_skill_sync_option_takes_value() {',
    '  case "$1:$2" in',
    `    ${takesValuePattern}) return 0 ;;`,
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '_skill_sync() {',
    '  local cur prev path word',
    '  local -i i command_end skip_next positional_index after_separator command_search_stopped',
    '  local -a candidates',
    '  cur="${words[CURRENT]}"',
    '  prev=""',
    '  if (( CURRENT > 1 )); then prev="${words[CURRENT - 1]}"; fi',
    '  path=""',
    '  command_end=2',
    '  skip_next=0',
    '  command_search_stopped=0',
    '',
    '  for (( i = 2; i < CURRENT; i++ )); do',
    '    word="${words[i]}"',
    '    if (( skip_next == 1 )); then skip_next=0; continue; fi',
    '    if [[ "$word" == -- ]]; then command_search_stopped=1; continue; fi',
    '    if (( command_search_stopped == 1 )); then continue; fi',
    '    if [[ "$word" == --project ]]; then skip_next=1; continue; fi',
    '    if [[ "$word" == --project=* || "$word" == --* ]]; then continue; fi',
    '    if [[ -z "$path" ]]; then',
    '      case "$word" in',
    ...commandPathCases(model),
    '      esac',
    '      continue',
    '    fi',
    '    if _skill_sync_is_parent "$path"; then',
    '      case "$path:$word" in',
    ...childPathCases(),
    '      esac',
    '    fi',
    '  done',
    '',
    '  if [[ -z "$path" ]] && (( command_search_stopped == 1 )); then return 0; fi',
    '',
    '  positional_index=0',
    '  skip_next=0',
    '  after_separator=0',
    '  for (( i = command_end; i < CURRENT; i++ )); do',
    '    word="${words[i]}"',
    '    if (( skip_next == 1 )); then skip_next=0; continue; fi',
    '    if (( after_separator == 0 )) && [[ "$word" == -- ]]; then after_separator=1; continue; fi',
    '    if (( after_separator == 0 )) && [[ "$word" == --*=* ]]; then continue; fi',
    '    if (( after_separator == 0 )) && [[ "$word" == -* ]]; then',
    '      if _skill_sync_option_takes_value "$path" "$word"; then skip_next=1; fi',
    '      continue',
    '    fi',
    '    (( positional_index += 1 ))',
    '  done',
    '',
    '  if (( after_separator == 0 )); then',
    '    case "$path:$prev" in',
    optionChoices,
    optionPaths,
    optionValues,
    '    esac',
    '    if [[ "$cur" == --*=* ]]; then',
    '      case "$path:${cur%%=*}" in',
    equalsChoices,
    equalsPaths,
    equalsValues,
    '      esac',
    '    fi',
    '  fi',
    '',
    '  if [[ "$cur" != -* ]] || (( after_separator == 1 )); then',
    '    case "$path:$positional_index" in',
    positionalChoices,
    positionalPaths,
    positionalValues,
    '    esac',
    '  fi',
    '',
    '  if (( after_separator == 1 )); then return 0; fi',
    '',
    '  case "$path" in',
    contextCandidates,
    '  esac',
    '  compadd -Q -- "${candidates[@]}"',
    '}',
    '',
    'if (( $+functions[compdef] )); then',
    '  compdef _skill_sync skill-sync',
    'fi',
  ].join('\n');
}

function fishOptionLine(condition: string, option: CompletionOption, description: string): string {
  const flags = option.flags.flatMap((flag) =>
    flag.startsWith('--') ? ['-l', fishQuote(flag.slice(2))] : ['-s', fishQuote(flag.slice(1))],
  );
  const valueParts = option.takesValue ? ['-r'] : [];
  const choiceParts =
    option.choices.length === 0 ? [] : ['-a', fishQuote(option.choices.join(' '))];
  const pathParts = option.valueKind === 'path' ? ['-F'] : [];
  return [
    'complete -c skill-sync',
    '-n',
    fishQuote(condition),
    ...flags,
    ...valueParts,
    ...choiceParts,
    ...pathParts,
    '-d',
    fishQuote(description),
  ].join(' ');
}

function fishScript(model: CompletionModel): string {
  const rootCommandNames = model.rootCandidates
    .map((candidate) => candidate.value)
    .filter((value) => !value.startsWith('-'));
  const rootCommandCase = `        case ${rootCommandNames.map(fishQuote).join(' ')}`;
  const childCases = commandDefinitions
    .filter((definition) => definition.path.length === 2)
    .flatMap((definition) => {
      const parent = definition.path[0] ?? '';
      const child = definition.path[1] ?? '';
      return [
        `        case ${fishQuote(`${parent}:${child}`)}`,
        `            set path ${fishQuote(definition.path.join(' '))}`,
        ...definition.aliases.flatMap((alias) => [
          `        case ${fishQuote(`${parent}:${alias}`)}`,
          `            set path ${fishQuote(definition.path.join(' '))}`,
        ]),
      ];
    });
  const takesValueCases = optionValueKeys(model).map(
    (key) => `        case ${fishQuote(key)}\n            return 0`,
  );

  const lines = [
    '# Fish completion for skill-sync. Generated from the typed command registry.',
    'function __skill_sync_command_path',
    '    set -l tokens (commandline -opc)',
    '    set -l path ""',
    '    set -l skip_next 0',
    '    set -l command_search_stopped 0',
    '    for token in $tokens[2..-1]',
    '        if test $skip_next -eq 1',
    '            set skip_next 0',
    '            continue',
    '        end',
    '        if test "$token" = --',
    '            set command_search_stopped 1',
    '            continue',
    '        end',
    '        if test $command_search_stopped -eq 1',
    '            continue',
    '        end',
    '        switch $token',
    '            case --project',
    '                set skip_next 1',
    '                continue',
    "            case '--project=*' --json --no-color --no-input --yes --global",
    '                continue',
    '        end',
    '        if test -z "$path"',
    '            switch $token',
    rootCommandCase,
    '                    set path $token',
    '            end',
    '            continue',
    '        end',
    `        if contains -- $path ${model.parents.map(fishQuote).join(' ')}`,
    '            switch "$path:$token"',
    ...childCases,
    '            end',
    '        end',
    '    end',
    '    echo $path',
    'end',
    '',
    'function __skill_sync_using_command',
    '    set -l actual (__skill_sync_command_path)',
    '    set -l expected (string join " " -- $argv)',
    '    test "$actual" = "$expected"',
    'end',
    '',
    'function __skill_sync_before_separator',
    '    set -l tokens (commandline -opc)',
    '    not contains -- -- $tokens[2..-1]',
    'end',
    '',
    'function __skill_sync_option_takes_value --argument-names path option',
    '    switch "$path:$option"',
    ...takesValueCases,
    '    end',
    '    return 1',
    'end',
    '',
    'function __skill_sync_at_argument_index --argument-names expected',
    '    set -l tokens (commandline -opc)',
    '    set -l path (__skill_sync_command_path)',
    '    set -l command_parts (string split " " -- $path)',
    '    set -l remaining_commands $command_parts',
    '    set -l in_arguments 0',
    '    set -l skip_next 0',
    '    set -l after_separator 0',
    '    set -l count 0',
    '    for token in $tokens[2..-1]',
    '        if test $skip_next -eq 1',
    '            set skip_next 0',
    '            continue',
    '        end',
    '        if test $in_arguments -eq 0',
    '            if test "$token" = --project',
    '                set skip_next 1',
    '                continue',
    '            end',
    '            if string match -qr "^--" -- $token',
    '                continue',
    '            end',
    '            if test (count $remaining_commands) -gt 0; and test "$token" = "$remaining_commands[1]"',
    '                set -e remaining_commands[1]',
    '                if test (count $remaining_commands) -eq 0',
    '                    set in_arguments 1',
    '                end',
    '            end',
    '            continue',
    '        end',
    '        if test $after_separator -eq 0; and test "$token" = --',
    '            set after_separator 1',
    '            continue',
    '        end',
    '        if test $after_separator -eq 0; and string match -qr "^--[^=]+=" -- $token',
    '            continue',
    '        end',
    '        if test $after_separator -eq 0; and string match -qr "^-" -- $token',
    '            if __skill_sync_option_takes_value "$path" "$token"',
    '                set skip_next 1',
    '            end',
    '            continue',
    '        end',
    '        set count (math $count + 1)',
    '    end',
    '    test $count -eq $expected',
    'end',
    '',
    'complete -c skill-sync -f',
  ];

  const rootCondition = '__skill_sync_using_command; and __skill_sync_before_separator';
  for (const candidate of model.rootCandidates.filter(
    (candidate) => !candidate.value.startsWith('-'),
  )) {
    lines.push(
      `complete -c skill-sync -n ${fishQuote(rootCondition)} -a ${fishQuote(candidate.value)} -d ${fishQuote(candidate.description)}`,
    );
  }
  for (const option of model.rootOptions) {
    lines.push(fishOptionLine(rootCondition, option, option.description));
  }
  for (const context of model.contexts) {
    const commandCondition = `__skill_sync_using_command ${context.path}`;
    const optionCondition = `${commandCondition}; and __skill_sync_before_separator`;
    const optionFlags = new Set(context.options.flatMap((option) => option.flags));
    for (const candidate of context.candidates.filter(
      (candidate) => !optionFlags.has(candidate.value),
    )) {
      lines.push(
        `complete -c skill-sync -n ${fishQuote(optionCondition)} -a ${fishQuote(candidate.value)} -d ${fishQuote(candidate.description)}`,
      );
    }
    for (const option of context.options) {
      lines.push(fishOptionLine(optionCondition, option, option.description));
    }
    for (const [index, values] of Object.entries(context.positionalChoices)) {
      lines.push(
        `complete -c skill-sync -n ${fishQuote(`${commandCondition}; and __skill_sync_at_argument_index ${index}`)} -a ${fishQuote(values.join(' '))}`,
      );
    }
    for (const [index, kind] of Object.entries(context.positionalValueKinds)) {
      if (kind !== 'path') continue;
      lines.push(
        `complete -c skill-sync -n ${fishQuote(`${commandCondition}; and __skill_sync_at_argument_index ${index}`)} -F`,
      );
    }
  }
  return lines.join('\n');
}

function powershellArray(values: readonly string[]): string {
  return `@(${values.map(powershellQuote).join(', ')})`;
}

function powershellHashtable(
  entries: readonly { readonly key: string; readonly values: readonly string[] }[],
): readonly string[] {
  return entries.map(
    ({ key, values }) => `    ${powershellQuote(key)} = ${powershellArray(values)}`,
  );
}

function powershellStringHashtable(
  entries: readonly { readonly key: string; readonly value: string }[],
): readonly string[] {
  return entries.map(({ key, value }) => `    ${powershellQuote(key)} = ${powershellQuote(value)}`);
}

function powershellScript(model: CompletionModel): string {
  const rootCommands = model.rootCandidates
    .map((candidate) => candidate.value)
    .filter((value) => !value.startsWith('-'));
  const topLevelAliases = commandDefinitions
    .filter((definition) => definition.path.length === 1)
    .flatMap((definition) =>
      definition.aliases.map((alias) => ({ alias, path: definition.path.join(' ') })),
    );
  const childAliases = commandDefinitions
    .filter((definition) => definition.path.length === 2)
    .flatMap((definition) =>
      definition.aliases.map((alias) => ({
        alias: `${definition.path[0] ?? ''}:${alias}`,
        path: definition.path.join(' '),
      })),
    );
  const childPaths = commandDefinitions
    .filter((definition) => definition.path.length === 2)
    .map((definition) => ({
      alias: `${definition.path[0] ?? ''}:${definition.path[1] ?? ''}`,
      path: definition.path.join(' '),
    }));
  const contexts = contextCandidateEntries(model);
  const choices = optionChoiceEntries(model);
  const positional = positionalChoiceEntries(model);
  const takesValue = optionValueKeys(model);
  const optionKinds = optionValueKindEntries(model).map(({ key, kind }) => ({
    key,
    value: kind,
  }));
  const positionalKinds = positionalValueKindEntries(model).map(({ key, kind }) => ({
    key,
    value: kind,
  }));

  return [
    '# PowerShell completion for skill-sync. Generated from the typed command registry.',
    '$skillSyncRootCommands = ' + powershellArray(rootCommands),
    '$skillSyncParents = ' + powershellArray(model.parents),
    '$skillSyncPathAliases = @{',
    ...topLevelAliases.map(
      ({ alias, path }) => `    ${powershellQuote(alias)} = ${powershellQuote(path)}`,
    ),
    ...childPaths.map(
      ({ alias, path }) => `    ${powershellQuote(alias)} = ${powershellQuote(path)}`,
    ),
    ...childAliases.map(
      ({ alias, path }) => `    ${powershellQuote(alias)} = ${powershellQuote(path)}`,
    ),
    '}',
    '$skillSyncCandidates = @{',
    ...powershellHashtable(contexts),
    '}',
    '$skillSyncOptionChoices = @{',
    ...powershellHashtable(choices),
    '}',
    '$skillSyncPositionalChoices = @{',
    ...powershellHashtable(positional),
    '}',
    '$skillSyncOptionKinds = @{',
    ...powershellStringHashtable(optionKinds),
    '}',
    '$skillSyncPositionalKinds = @{',
    ...powershellStringHashtable(positionalKinds),
    '}',
    '$skillSyncValueOptions = ' + powershellArray(takesValue),
    '',
    'Register-ArgumentCompleter -Native -CommandName skill-sync -ScriptBlock {',
    '    param($wordToComplete, $commandAst, $cursorPosition)',
    '    $elements = @($commandAst.CommandElements | Where-Object { $_.Extent.StartOffset -lt $cursorPosition })',
    '    $tokens = @()',
    '    foreach ($element in @($elements | Select-Object -Skip 1)) {',
    '        if ($element.Extent.EndOffset -ge $cursorPosition) { continue }',
    '        $valueProperty = $element.PSObject.Properties["Value"]',
    '        $tokens += if ($null -ne $valueProperty) { [string]$valueProperty.Value } else { $element.Extent.Text }',
    '    }',
    '    $path = ""',
    '    $commandEnd = 0',
    '    $skipNext = $false',
    '    $commandSearchStopped = $false',
    '    for ($index = 0; $index -lt $tokens.Count; $index += 1) {',
    '        $token = $tokens[$index]',
    '        if ($skipNext) { $skipNext = $false; continue }',
    '        if ($token -eq "--") { $commandSearchStopped = $true; continue }',
    '        if ($commandSearchStopped) { continue }',
    '        if ($token -eq "--project") { $skipNext = $true; continue }',
    '        if ($token.StartsWith("--project=") -or $token.StartsWith("--")) { continue }',
    '        if ($path.Length -eq 0) {',
    '            if ($skillSyncRootCommands -contains $token) {',
    '                $path = if ($skillSyncPathAliases.ContainsKey($token)) { $skillSyncPathAliases[$token] } else { $token }',
    '                $commandEnd = $index + 1',
    '            }',
    '            continue',
    '        }',
    '        if ($skillSyncParents -contains $path) {',
    '            $childKey = "$path`:$token"',
    '            if ($skillSyncPathAliases.ContainsKey($childKey)) {',
    '                $path = $skillSyncPathAliases[$childKey]',
    '                $commandEnd = $index + 1',
    '            }',
    '        }',
    '    }',
    '    $previous = if ($tokens.Count -gt 0) { $tokens[-1] } else { "" }',
    '    $position = 0',
    '    $skipNext = $false',
    '    $afterSeparator = $false',
    '    for ($index = $commandEnd; $index -lt $tokens.Count; $index += 1) {',
    '        $token = $tokens[$index]',
    '        if ($skipNext) { $skipNext = $false; continue }',
    '        if (-not $afterSeparator -and $token -eq "--") { $afterSeparator = $true; continue }',
    '        if (-not $afterSeparator -and $token -match "^--[^=]+=") { continue }',
    '        if (-not $afterSeparator -and $token.StartsWith("-")) {',
    '            if ($skillSyncValueOptions -contains "$path`:$token") { $skipNext = $true }',
    '            continue',
    '        }',
    '        $position += 1',
    '    }',
    '    if (-not $afterSeparator -and $wordToComplete -match "^(--[^=]+)=(.*)$") {',
    '        $optionName = $Matches[1]',
    '        $optionValue = $Matches[2]',
    '        $equalsKey = "$path`:$optionName"',
    '        if ($skillSyncOptionChoices.ContainsKey($equalsKey)) {',
    '            $skillSyncOptionChoices[$equalsKey] | ForEach-Object { "$optionName=$_" } | Where-Object { $_.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {',
    '                [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
    '            }',
    '            return',
    '        }',
    '        if ($skillSyncOptionKinds[$equalsKey] -eq "path") {',
    '            [System.Management.Automation.CompletionCompleters]::CompleteFilename($optionValue) | ForEach-Object {',
    '                $completionText = "$optionName=$($_.CompletionText)"',
    '                [System.Management.Automation.CompletionResult]::new($completionText, $completionText, $_.ResultType, $_.ToolTip)',
    '            }',
    '            return',
    '        }',
    '        if ($skillSyncOptionKinds.ContainsKey($equalsKey)) { return }',
    '    }',
    '    if (-not $afterSeparator) {',
    '        $choiceKey = "$path`:$previous"',
    '        if ($skillSyncOptionChoices.ContainsKey($choiceKey)) {',
    '            $candidates = $skillSyncOptionChoices[$choiceKey]',
    '        } elseif ($skillSyncOptionKinds[$choiceKey] -eq "path") {',
    '            [System.Management.Automation.CompletionCompleters]::CompleteFilename($wordToComplete)',
    '            return',
    '        } elseif ($skillSyncOptionKinds.ContainsKey($choiceKey)) {',
    '            return',
    '        }',
    '    }',
    '    if ($null -eq $candidates) {',
    '        $positionKey = "$path`:$position"',
    '        if ((-not $wordToComplete.StartsWith("-") -or $afterSeparator) -and $skillSyncPositionalChoices.ContainsKey($positionKey)) {',
    '            $candidates = $skillSyncPositionalChoices[$positionKey]',
    '        } elseif ((-not $wordToComplete.StartsWith("-") -or $afterSeparator) -and $skillSyncPositionalKinds[$positionKey] -eq "path") {',
    '            [System.Management.Automation.CompletionCompleters]::CompleteFilename($wordToComplete)',
    '            return',
    '        } elseif ((-not $wordToComplete.StartsWith("-") -or $afterSeparator) -and $skillSyncPositionalKinds.ContainsKey($positionKey)) {',
    '            return',
    '        } elseif ($afterSeparator) {',
    '            $candidates = @()',
    '        } elseif ($skillSyncCandidates.ContainsKey($path)) {',
    '            $candidates = $skillSyncCandidates[$path]',
    '        } else {',
    '            $candidates = @()',
    '        }',
    '    }',
    '    $candidates | Where-Object { $_.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {',
    '        [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
    '    }',
    '}',
  ].join('\n');
}

export function generateCompletionScript(shell: CompletionShell): string {
  const model = buildCompletionModel();
  switch (shell) {
    case 'bash':
      return bashScript(model);
    case 'zsh':
      return zshScript(model);
    case 'fish':
      return fishScript(model);
    case 'powershell':
      return powershellScript(model);
  }
}
