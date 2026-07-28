import { describe, expect, it } from 'vitest';

import {
  backFromTuiScreen,
  compatibleAdoptionSkillIds,
  initialTuiNavigation,
  moveTuiCursor,
  overviewDestination,
} from '../../src/ui/tui/controller.js';

describe('TUI navigation controller', () => {
  it('keeps navigation within the visible screen bounds', () => {
    expect(moveTuiCursor(initialTuiNavigation(), -1, 3)).toEqual({ cursor: 0, screen: 'overview' });
    expect(moveTuiCursor({ cursor: 0, screen: 'catalog' }, 9, 3)).toEqual({
      cursor: 2,
      screen: 'catalog',
    });
  });

  it('maps overview actions and back behavior without renderer state', () => {
    expect(overviewDestination(0)).toBe('catalog');
    expect(overviewDestination(2)).toBe('unmanaged');
    expect(overviewDestination(3)).toBe('quit');
    expect(backFromTuiScreen('catalog')).toBe('overview');
    expect(backFromTuiScreen('detail')).toBe('catalog');
    expect(backFromTuiScreen('adopt-candidate')).toBe('unmanaged');
    expect(backFromTuiScreen('adopt-review')).toBe('adopt-candidate');
    expect(backFromTuiScreen('overview')).toBe('quit');
  });

  it('keeps duplicate leaf names explicit when choosing a canonical adoption skill', () => {
    expect(
      compatibleAdoptionSkillIds(
        [
          { id: 'backend/review-ui', compatibleAgents: ['codex'] },
          { id: 'frontend/review-ui', compatibleAgents: ['codex', 'claude'] },
          { id: 'writing/edit', compatibleAgents: ['claude'] },
        ],
        'codex',
      ),
    ).toEqual(['backend/review-ui', 'frontend/review-ui']);
  });
});
