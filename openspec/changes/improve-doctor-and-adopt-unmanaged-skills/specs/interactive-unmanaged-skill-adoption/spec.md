## ADDED Requirements

### Requirement: The TUI exposes eligible unmanaged entries for explicit adoption
The interactive inventory SHALL identify which entries are eligible for adoption and allow users to
select an eligible unmanaged entry. It MUST keep managed, invalid, unknown, and state-unreliable
entries non-adoptable with a visible reason. Browsing, selecting, refreshing, backing out, and
quitting the inventory MUST remain read-only until a user accepts an adoption review.

#### Scenario: User selects a valid unmanaged inventory entry
- **WHEN** the inventory contains a validated unmanaged Codex skill and selected-scope state is
  reliable
- **THEN** the user can select it for adoption and proceed to choose a canonical catalog skill

#### Scenario: User opens an invalid inventory entry
- **WHEN** an inventory entry has validation issues
- **THEN** the TUI displays its issue and does not offer an adoption action

### Requirement: The TUI requires a canonical selection and final review
The interactive workflow SHALL require the user to choose an explicit compatible qualified catalog
skill ID before adoption. It SHALL present a review with the selected scope, target, local path,
canonical ID, exact-match requirement, and statement that no target files will be replaced. The
system MUST call the shared adoption workflow only after explicit confirmation and MUST display its
structured result before allowing a refresh or further navigation.

#### Scenario: User confirms adoption review
- **WHEN** the user accepts a review for an eligible unmanaged local copy and explicit compatible
  canonical ID
- **THEN** the TUI invokes the shared adoption operation and refreshes the inventory after success

#### Scenario: User cancels adoption review
- **WHEN** the user leaves the adoption review without accepting it
- **THEN** no target file or selected-scope tracking state changes

#### Scenario: Exact-match verification fails after review
- **WHEN** the shared adoption operation finds that the selected local directory differs from the
  canonical library skill
- **THEN** the TUI displays the recoverable failure and leaves the local directory unmanaged
