import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';

import type { CommandResult } from '../../domain/result.js';
import {
  backFromTuiScreen,
  compatibleAdoptionSkillIds,
  moveTuiCursor,
  overviewDestination,
  type TuiScreen,
} from './controller.js';
import { terminalSafe } from './sanitize.js';
import type { TuiActionPort, TuiDashboard, TuiInventorySkill, TuiSkill } from './types.js';

const palette = {
  accent: 'magenta',
  muted: 'gray',
  positive: 'green',
  warning: 'yellow',
} as const;

function badgeColor(state: string): 'green' | 'red' | 'yellow' | 'gray' {
  if (state === 'current' || state === 'managed') return 'green';
  if (state.includes('modified') || state.includes('conflict') || state === 'invalid') return 'red';
  if (state.includes('outdated') || state === 'unmanaged' || state === 'unknown') return 'yellow';
  return 'gray';
}

function operationMessage(result: CommandResult<unknown>): string {
  if (result.ok) return 'Operation completed. Refreshing dashboard…';
  return result.errors.map((error) => terminalSafe(`${error.code}: ${error.message}`)).join('\n');
}

function visibleSkills(
  skills: readonly TuiSkill[],
  query: string,
  activeGroup: string | null,
): readonly TuiSkill[] {
  const normalized = query.toLocaleLowerCase('en-US');
  return skills.filter((skill) => {
    const inGroup =
      activeGroup === null ||
      skill.group === activeGroup ||
      skill.group?.startsWith(`${activeGroup}/`) === true;
    const matchesQuery =
      normalized === '' ||
      `${skill.id}\n${skill.description}`.toLocaleLowerCase('en-US').includes(normalized);
    return inGroup && matchesQuery;
  });
}

function withColor(color: string | undefined): Readonly<Record<string, string>> {
  return color === undefined ? {} : { color };
}

function Header(props: {
  readonly color: boolean;
  readonly compact: boolean;
  readonly scope: string;
}): ReactElement {
  return createElement(
    Box,
    {
      ...(props.color ? { borderColor: palette.accent } : {}),
      borderStyle: 'round',
      paddingX: 1,
    },
    createElement(
      Text,
      { bold: props.color, ...withColor(props.color ? palette.accent : undefined) },
      props.compact
        ? `skill-sync · ${props.scope}`
        : `✦ skill-sync command center · ${props.scope} scope`,
    ),
  );
}

function StatusBadge(props: { readonly color: boolean; readonly state: string }): ReactElement {
  return createElement(
    Text,
    withColor(props.color ? badgeColor(props.state) : undefined),
    `[${props.state}]`,
  );
}

export function TuiApp(props: {
  readonly actions: TuiActionPort;
  readonly color: boolean;
  readonly implicit: boolean;
}): ReactElement {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const compact = columns < 78;
  const [dashboard, setDashboard] = useState<TuiDashboard | undefined>();
  const [screen, setScreen] = useState<TuiScreen>('overview');
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [targets, setTargets] = useState<ReadonlySet<string>>(() => new Set(['codex']));
  const [discardLocal, setDiscardLocal] = useState(false);
  const [adoptionEntry, setAdoptionEntry] = useState<TuiInventorySkill | undefined>();
  const [adoptionSkillId, setAdoptionSkillId] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const reload = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await props.actions.load();
      setDashboard(next);
      setNotice(next.errors.length === 0 ? undefined : next.errors.join('\n'));
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to load the dashboard.'),
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const skills = useMemo(
    () => visibleSkills(dashboard?.skills ?? [], query, activeGroup),
    [activeGroup, dashboard?.skills, query],
  );
  const selectedSkill = skills[cursor];
  const groups = useMemo(
    () =>
      [
        ...new Set(
          (dashboard?.skills ?? []).flatMap((skill) => (skill.group === null ? [] : [skill.group])),
        ),
      ].sort(),
    [dashboard?.skills],
  );
  const eligibleTargets = useMemo(() => {
    const chosenSkills = (dashboard?.skills ?? []).filter((skill) => selected.has(skill.id));
    if (chosenSkills.length === 0) return new Set(['codex', 'claude']);
    return new Set(
      ['codex', 'claude'].filter((target) =>
        chosenSkills.every((skill) => skill.compatibleAgents.includes(target)),
      ),
    );
  }, [dashboard?.skills, selected]);
  const adoptionCandidates = useMemo(() => {
    if (adoptionEntry === undefined) return [];
    const byId = new Map((dashboard?.skills ?? []).map((skill) => [skill.id, skill]));
    return compatibleAdoptionSkillIds(dashboard?.skills ?? [], adoptionEntry.target).flatMap(
      (id) => {
        const skill = byId.get(id);
        return skill === undefined ? [] : [skill];
      },
    );
  }, [adoptionEntry, dashboard?.skills]);
  const selectedAdoptionCandidate = adoptionCandidates[cursor];
  const move = (amount: number): void => {
    const nextLength =
      screen === 'catalog'
        ? skills.length
        : screen === 'managed'
          ? (dashboard?.managed.length ?? 0)
          : screen === 'unmanaged'
            ? (dashboard?.inventory.length ?? 0)
            : screen === 'adopt-candidate'
              ? adoptionCandidates.length
              : 4;
    setCursor((value) => moveTuiCursor({ cursor: value, screen }, amount, nextLength).cursor);
  };

  const install = async (): Promise<void> => {
    const chosenTargets = [...targets].filter((target) => eligibleTargets.has(target));
    if (selected.size === 0 || chosenTargets.length === 0) {
      setNotice('Select at least one skill and target before installing.');
      return;
    }
    setBusy(true);
    const result = await props.actions.install([...selected], chosenTargets);
    setNotice(operationMessage(result));
    setBusy(false);
    setScreen('overview');
    if (result.ok) await reload();
  };

  const sync = async (): Promise<void> => {
    setBusy(true);
    const result = await props.actions.sync(discardLocal);
    setNotice(operationMessage(result));
    setBusy(false);
    setScreen('managed');
    if (result.ok) await reload();
  };

  const adopt = async (): Promise<void> => {
    if (adoptionEntry === undefined || adoptionSkillId === undefined) {
      setNotice('Choose an unmanaged entry and an exact canonical skill ID before adoption.');
      return;
    }
    setBusy(true);
    const result = await props.actions.adopt(adoptionSkillId, adoptionEntry.target);
    setNotice(operationMessage(result));
    setBusy(false);
    if (result.ok) {
      setScreen('unmanaged');
      setCursor(0);
      setAdoptionEntry(undefined);
      setAdoptionSkillId(undefined);
      await reload();
    }
  };

  useInput((input, key) => {
    if (busy) return;
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow) {
      move(1);
      return;
    }
    if (key.escape) {
      const destination = backFromTuiScreen(screen);
      if (destination === 'quit') exit();
      else {
        setScreen(destination);
        setCursor(0);
      }
      return;
    }
    if (input === 'r') {
      void reload();
      return;
    }
    if (screen === 'overview' && key.return) {
      const destination = overviewDestination(cursor);
      if (destination === 'quit') exit();
      else setScreen(destination);
      setCursor(0);
      return;
    }
    if (screen === 'catalog') {
      if (key.return && selectedSkill !== undefined) {
        setScreen('detail');
        return;
      }
      if (input === ' ') {
        if (selectedSkill === undefined) return;
        setSelected((value) => {
          const next = new Set(value);
          if (next.has(selectedSkill.id)) next.delete(selectedSkill.id);
          else next.add(selectedSkill.id);
          return next;
        });
        return;
      }
      if (input === 'i') {
        setScreen('install-review');
        return;
      }
      if (input === 'g') {
        setActiveGroup((value) => {
          const index = value === null ? -1 : groups.indexOf(value);
          return index >= groups.length - 1 ? null : (groups[index + 1] ?? null);
        });
        setCursor(0);
        return;
      }
      if (key.backspace) {
        setQuery((value) => value.slice(0, -1));
        setCursor(0);
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1 && input !== ' ') {
        setQuery((value) => value + terminalSafe(input));
        setCursor(0);
      }
      return;
    }
    if (screen === 'detail') {
      if (input === ' ') {
        if (selectedSkill === undefined) return;
        setSelected((value) => {
          const next = new Set(value);
          if (next.has(selectedSkill.id)) next.delete(selectedSkill.id);
          else next.add(selectedSkill.id);
          return next;
        });
        return;
      }
      if (input === 'i') setScreen('install-review');
      return;
    }
    if (screen === 'install-review') {
      if (input === '1' || input === '2') {
        const target = input === '1' ? 'codex' : 'claude';
        if (!eligibleTargets.has(target)) return;
        setTargets((value) => {
          const next = new Set(value);
          if (next.has(target)) next.delete(target);
          else next.add(target);
          return next;
        });
        return;
      }
      if (input === 'y') void install();
      return;
    }
    if (screen === 'managed') {
      if (input === 's') setScreen('sync-review');
      return;
    }
    if (screen === 'sync-review') {
      if (input === 'd') setDiscardLocal((value) => !value);
      if (input === 'y') void sync();
      return;
    }
    if (screen === 'unmanaged') {
      if (key.return || input === 'a') {
        const entry = dashboard?.inventory[cursor];
        if (entry === undefined) return;
        if (!entry.adoptable) {
          setNotice(
            entry.issues.length > 0
              ? entry.issues.join('\n')
              : `${entry.name} cannot be adopted until its selected-scope state is reliable.`,
          );
          return;
        }
        setAdoptionEntry(entry);
        setAdoptionSkillId(undefined);
        setCursor(0);
        setScreen('adopt-candidate');
      }
      return;
    }
    if (screen === 'adopt-candidate') {
      if (key.return && selectedAdoptionCandidate !== undefined) {
        setAdoptionSkillId(selectedAdoptionCandidate.id);
        setScreen('adopt-review');
      }
      return;
    }
    if (input === 'y') {
      void adopt();
    }
  });

  const muted = props.color ? palette.muted : undefined;
  const content = (() => {
    if (dashboard === undefined) {
      return createElement(Text, withColor(muted), 'Loading your skill library…');
    }
    if (screen === 'overview') {
      const items = [
        `Browse library (${String(dashboard.skills.length)} skills)`,
        `Managed skills (${String(dashboard.managed.length)})`,
        `Unmanaged inventory (${String(dashboard.inventory.filter((item) => item.status === 'unmanaged').length)})`,
        'Quit',
      ];
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'What would you like to do?'),
        ...items.map((item, index) =>
          createElement(
            Text,
            {
              key: item,
              ...withColor(cursor === index && props.color ? palette.accent : undefined),
            },
            `${cursor === index ? '❯' : ' '} ${item}`,
          ),
        ),
        createElement(Text, withColor(muted), '↑↓ move · Enter open · r refresh · q quit'),
      );
    }
    if (screen === 'catalog') {
      const group = (skill: TuiSkill): string => skill.group ?? 'root';
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Library browser'),
        createElement(
          Text,
          withColor(muted),
          `Group: ${activeGroup ?? 'all'} · Search: ${query || 'all skills'} · ${String(selected.size)} selected`,
        ),
        ...skills.slice(0, compact ? 9 : 16).map((skill, index) =>
          createElement(
            Text,
            {
              key: skill.id,
              ...withColor(cursor === index && props.color ? palette.accent : undefined),
            },
            `${cursor === index ? '❯' : ' '} ${selected.has(skill.id) ? '◉' : '○'} ${skill.id} · ${group(skill)} · ${skill.description} [${skill.installationState}]`,
          ),
        ),
        createElement(
          Text,
          withColor(muted),
          'g group · Type search · Space toggle · Enter details · i review install · Esc back',
        ),
      );
    }
    if (screen === 'detail') {
      if (selectedSkill === undefined) {
        return createElement(
          Text,
          withColor(muted),
          'No skill is selected. Press Esc to return to the catalog.',
        );
      }
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, selectedSkill.id),
        createElement(Text, null, selectedSkill.description),
        createElement(Text, null, `Group: ${selectedSkill.group ?? 'root'}`),
        createElement(
          Text,
          null,
          `Compatible targets: ${selectedSkill.compatibleAgents.join(', ') || 'none declared'}`,
        ),
        createElement(StatusBadge, { color: props.color, state: selectedSkill.installationState }),
        createElement(
          Text,
          withColor(muted),
          'Space toggle selection · i review install · Esc catalog',
        ),
      );
    }
    if (screen === 'install-review') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Review installation'),
        createElement(Text, null, `Skills: ${[...selected].join(', ') || 'none selected'}`),
        createElement(
          Text,
          null,
          `Targets: 1 ${targets.has('codex') ? '◉' : '○'} Codex${eligibleTargets.has('codex') ? '' : ' (incompatible)'}   2 ${targets.has('claude') ? '◉' : '○'} Claude${eligibleTargets.has('claude') ? '' : ' (incompatible)'}`,
        ),
        createElement(
          Text,
          withColor(props.color ? palette.warning : undefined),
          'No files change until you confirm.',
        ),
        createElement(Text, withColor(muted), '1/2 toggle targets · y install · Esc cancel'),
      );
    }
    if (screen === 'managed') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Managed skills'),
        ...(dashboard.managed.length === 0
          ? [
              createElement(
                Text,
                { key: 'empty', ...withColor(muted) },
                'No managed skills in this scope.',
              ),
            ]
          : dashboard.managed.map((skill) =>
              createElement(
                Text,
                { key: skill.id },
                `${skill.id} `,
                createElement(StatusBadge, { color: props.color, state: skill.state }),
              ),
            )),
        createElement(Text, withColor(muted), 's review sync · r refresh · Esc back'),
      );
    }
    if (screen === 'sync-review') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Review synchronization'),
        createElement(
          Text,
          null,
          'The existing reconciliation safeguards will check every tracked skill.',
        ),
        createElement(
          Text,
          withColor(props.color && discardLocal ? palette.warning : undefined),
          `d ${discardLocal ? '◉' : '○'} Allow discard-local (requires backup and confirmation)`,
        ),
        createElement(Text, withColor(muted), 'y sync · d toggle discard-local · Esc cancel'),
      );
    }
    if (screen === 'unmanaged') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Unmanaged skill inventory'),
        ...(dashboard.inventory.length === 0
          ? [
              createElement(
                Text,
                { key: 'empty', ...withColor(muted) },
                'No on-disk skills found in supported target roots.',
              ),
            ]
          : dashboard.inventory.map((skill, index) =>
              createElement(
                Text,
                {
                  key: `${skill.target}:${skill.path}`,
                  ...withColor(cursor === index && props.color ? palette.accent : undefined),
                },
                `${cursor === index ? '❯' : ' '} ${skill.target} · ${skill.name} `,
                createElement(StatusBadge, { color: props.color, state: skill.status }),
                skill.adoptable ? ' · [adoptable]' : ' · [read-only]',
                ` · ${skill.path}`,
              ),
            )),
        ...dashboard.inventoryIssues.map((issue) =>
          createElement(
            Text,
            { key: issue, ...withColor(props.color ? palette.warning : undefined) },
            issue,
          ),
        ),
        createElement(
          Text,
          withColor(muted),
          '↑↓ move · Enter/a choose adoptable skill · r refresh · Esc back',
        ),
      );
    }
    if (screen === 'adopt-candidate') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Choose canonical skill to adopt'),
        createElement(
          Text,
          null,
          adoptionEntry === undefined
            ? 'No unmanaged target skill is selected.'
            : `Local copy: ${adoptionEntry.target} · ${adoptionEntry.path}`,
        ),
        ...(adoptionCandidates.length === 0
          ? [
              createElement(
                Text,
                { key: 'empty', ...withColor(props.color ? palette.warning : undefined) },
                `No catalog skills declare compatibility with ${adoptionEntry?.target ?? 'this target'}.`,
              ),
            ]
          : adoptionCandidates.slice(0, compact ? 9 : 16).map((skill, index) =>
              createElement(
                Text,
                {
                  key: skill.id,
                  ...withColor(cursor === index && props.color ? palette.accent : undefined),
                },
                `${cursor === index ? '❯' : ' '} ${skill.id} · ${skill.description}`,
              ),
            )),
        createElement(
          Text,
          withColor(muted),
          'Choose one exact qualified ID · Enter review · Esc inventory',
        ),
      );
    }
    return createElement(
      Box,
      { flexDirection: 'column', gap: 1 },
      createElement(Text, { bold: props.color }, 'Review unmanaged-skill adoption'),
      createElement(Text, null, `Scope: ${dashboard.scope}`),
      createElement(
        Text,
        null,
        `Local target: ${adoptionEntry?.target ?? 'unknown'} · ${adoptionEntry?.path ?? 'unknown'}`,
      ),
      createElement(Text, null, `Canonical skill: ${adoptionSkillId ?? 'none selected'}`),
      createElement(
        Text,
        withColor(props.color ? palette.warning : undefined),
        'Adoption only succeeds if the local directory exactly matches this canonical skill. Target files will not be replaced.',
      ),
      createElement(Text, withColor(muted), 'y adopt · Esc cancel'),
    );
  })();

  return createElement(
    Box,
    { flexDirection: 'column', gap: 1, padding: 1 },
    createElement(Header, { color: props.color, compact, scope: dashboard?.scope ?? 'project' }),
    busy ? createElement(Text, withColor(muted), 'Working safely…') : content,
    notice === undefined
      ? null
      : createElement(Text, withColor(props.color ? palette.warning : undefined), notice),
    createElement(
      Text,
      withColor(muted),
      props.implicit ? 'Started from skill-sync' : 'Started from skill-sync tui',
    ),
  );
}
