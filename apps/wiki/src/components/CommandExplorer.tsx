import { useId, useState } from 'react';

import type { CommandCategory, WikiCommand } from '../data/commands';
import './CommandExplorer.css';

interface CommandExplorerProps {
  readonly commands: readonly WikiCommand[];
  readonly categories: readonly CommandCategory[];
}

type CategoryFilter = 'All' | CommandCategory;

export function CommandExplorer({ commands, categories }: CommandExplorerProps) {
  const searchId = useId();
  const categoryId = useId();
  const statusId = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('All');
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const filteredCommands = commands.filter((command) => {
    const matchesCategory = category === 'All' || command.category === category;
    const searchableText = [command.name, command.summary, ...command.keywords]
      .join(' ')
      .toLocaleLowerCase();
    return matchesCategory && searchableText.includes(normalizedQuery);
  });

  return (
    <section className="command-explorer" aria-labelledby={`${statusId}-heading`}>
      <div className="command-explorer__heading">
        <div>
          <p className="command-explorer__eyebrow">Interactive index</p>
          <h2 id={`${statusId}-heading`}>Find a command</h2>
        </div>
        <p id={statusId} className="command-explorer__count" aria-live="polite">
          {filteredCommands.length} {filteredCommands.length === 1 ? 'command' : 'commands'}
        </p>
      </div>

      <div className="command-explorer__filters">
        <label htmlFor={searchId}>
          Search
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder="Try “offline” or “publish”"
            aria-describedby={statusId}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>

        <label htmlFor={categoryId}>
          Category
          <select
            id={categoryId}
            value={category}
            aria-describedby={statusId}
            onChange={(event) => setCategory(event.currentTarget.value as CategoryFilter)}
          >
            <option value="All">All commands</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filteredCommands.length === 0 ? (
        <p className="command-explorer__empty">No commands match those filters.</p>
      ) : (
        <ul className="command-explorer__results" aria-describedby={statusId}>
          {filteredCommands.map((command) => (
            <li key={command.name}>
              <a href={command.href}>
                <span className="command-explorer__meta">
                  <code>{command.name}</code>
                  <span>{command.category}</span>
                </span>
                <span>{command.summary}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
