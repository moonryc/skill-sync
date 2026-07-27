## ADDED Requirements

### Requirement: Nx-managed wiki application

The repository SHALL contain a private npm workspace application named `wiki` at `apps/wiki`, and Nx SHALL identify it as an application project independently from the `cli` library.

#### Scenario: Nx discovers the wiki

- **WHEN** a developer queries the Nx project graph after installing workspace dependencies
- **THEN** Nx reports an application named `wiki` rooted at `apps/wiki` with serve, build, preview, type-check, and lint targets

#### Scenario: Developer starts the wiki

- **WHEN** a developer runs the documented wiki development command from the repository root
- **THEN** Nx starts the Astro development server and serves the wiki with live content updates

### Requirement: Astro site with React support

The wiki SHALL be built with Astro and SHALL configure the official React integration so typed React components can be rendered as isolated, explicitly hydrated UI islands within otherwise static documentation pages.

#### Scenario: Static documentation renders without hydration

- **WHEN** a reader loads a normal documentation route with client-side JavaScript unavailable
- **THEN** the page content, navigation, code samples, and links remain readable and usable

#### Scenario: React command explorer is interactive

- **WHEN** a reader loads the command-reference overview with client-side JavaScript enabled and filters commands by text or category
- **THEN** the React command explorer updates the visible matching commands and preserves links to their full reference sections

### Requirement: Structured CLI documentation

The wiki SHALL provide maintained documentation for installation and quick start, the canonical library and project-state model, common workflows, the complete public command surface, configuration, conflict and recovery behavior, security boundaries, automation and exit statuses, troubleshooting, and contributor development and release workflows.

#### Scenario: New user follows the primary journey

- **WHEN** a reader starts from the wiki home page
- **THEN** the reader can navigate through installation, library connection, adding a skill, project installation, and synchronization guidance in task order

#### Scenario: Operator finds command behavior

- **WHEN** a reader opens the command reference
- **THEN** the wiki documents every public command and global option represented by the current CLI help and repository README, including safety-relevant confirmations and overwrite controls

#### Scenario: Contributor finds repository guidance

- **WHEN** a contributor opens the development section
- **THEN** the wiki explains the Nx project layout, supported Node versions, validation commands, CLI package staging path, and the obligation to update command documentation when the public surface changes

### Requirement: Navigable and searchable knowledge base

The wiki SHALL expose stable route-level links, an explicitly ordered hierarchical sidebar, page-local headings, and static full-text search across its documentation content.

#### Scenario: Reader searches the built wiki

- **WHEN** a reader searches the production build for a documented command, option, exit status, or troubleshooting term
- **THEN** matching pages are returned without requiring a remote search service

#### Scenario: Reader follows a deep link

- **WHEN** a reader opens a direct URL to a documentation page or reference heading
- **THEN** the relevant content loads and remains reachable through the visible navigation hierarchy

#### Scenario: Reader uses a narrow viewport

- **WHEN** the wiki is viewed on a mobile-sized screen
- **THEN** navigation, search, prose, tables, and code samples remain operable without page-level horizontal scrolling

### Requirement: Accessible documentation presentation

The wiki SHALL use semantic document structure, keyboard-operable controls, visible focus states, sufficient color contrast, and user-selectable light and dark presentation modes.

#### Scenario: Keyboard-only navigation

- **WHEN** a reader uses only a keyboard to traverse site navigation, search, theme controls, and the React command explorer
- **THEN** every interactive control is reachable, visibly focused, labeled, and operable in a logical order

#### Scenario: Reader selects a color theme

- **WHEN** a reader selects light, dark, or system-derived presentation
- **THEN** the site applies the selection consistently without obscuring prose, links, code, or focus indicators

### Requirement: Reproducible static wiki build

The wiki build SHALL produce a deterministic static site at `dist/apps/wiki`, and the output MUST remain separate from the publishable CLI package staged at `dist/libs/cli`.

#### Scenario: Production build succeeds

- **WHEN** a developer or CI runs the Nx wiki build target from a clean dependency installation
- **THEN** Astro generates deployable static HTML and assets under `dist/apps/wiki`

#### Scenario: CLI package boundary is preserved

- **WHEN** both the CLI and wiki are built
- **THEN** wiki files exist only in the wiki output and the contents and executable contract of `dist/libs/cli` are unchanged

### Requirement: Wiki quality gates

The repository SHALL provide cache-aware Nx targets for wiki building, type checking, and linting, and the normal root validation workflow SHALL format-check, lint, type-check, and production-build the wiki in addition to retaining all existing CLI checks.

#### Scenario: Repository validation includes the wiki

- **WHEN** a developer or CI runs the root validation command
- **THEN** invalid wiki formatting, TypeScript or Astro diagnostics, lint failures, broken content schema, or production build failures cause the command to fail

#### Scenario: Wiki-only validation is available

- **WHEN** a developer runs an individual wiki build, type-check, or lint target through Nx
- **THEN** Nx evaluates the declared wiki inputs and reuses a valid cached result where applicable
