import type { Clock, RuntimeIo } from '../ports/index.js';

export interface ApplicationContext {
  readonly clock: Clock;
  readonly io: RuntimeIo;
}
