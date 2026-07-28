export type TuiScreen =
  | 'adopt-candidate'
  | 'adopt-review'
  | 'catalog'
  | 'detail'
  | 'install-review'
  | 'managed'
  | 'overview'
  | 'sync-review'
  | 'unmanaged';

export interface TuiNavigationState {
  readonly cursor: number;
  readonly screen: TuiScreen;
}

export function initialTuiNavigation(): TuiNavigationState {
  return { cursor: 0, screen: 'overview' };
}

export function moveTuiCursor(
  state: TuiNavigationState,
  amount: number,
  itemCount: number,
): TuiNavigationState {
  if (itemCount <= 0) return state;
  return {
    ...state,
    cursor: Math.max(0, Math.min(itemCount - 1, state.cursor + amount)),
  };
}

export function overviewDestination(cursor: number): TuiScreen | 'quit' {
  return (['catalog', 'managed', 'unmanaged', 'quit'] as const)[cursor] ?? 'overview';
}

export function backFromTuiScreen(screen: TuiScreen): TuiScreen | 'quit' {
  if (screen === 'overview') return 'quit';
  if (screen === 'detail' || screen === 'install-review') return 'catalog';
  if (screen === 'adopt-candidate') return 'unmanaged';
  if (screen === 'adopt-review') return 'adopt-candidate';
  if (screen === 'sync-review') return 'managed';
  return 'overview';
}

/** Always return exact IDs; leaf names are deliberately not used to choose a canonical skill. */
export function compatibleAdoptionSkillIds(
  skills: readonly { readonly compatibleAgents: readonly string[]; readonly id: string }[],
  target: string,
): readonly string[] {
  return skills
    .filter((skill) => skill.compatibleAgents.includes(target))
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));
}
