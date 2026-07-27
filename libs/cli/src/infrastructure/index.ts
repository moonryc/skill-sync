import type { Clock } from '../ports/index.js';

export const systemClock: Clock = {
  now: () => new Date(),
};

export * from './config.js';
export * from './project-state.js';
export * from './stable-json.js';
export * from './transactions.js';
