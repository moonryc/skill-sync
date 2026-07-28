## ADDED Requirements

### Requirement: Human doctor results are scannable and actionable
The system SHALL render a non-JSON doctor result with a clear overall healthy, attention-needed,
or blocked summary; human-friendly diagnostic labels; grouped check outcomes; and a distinct
remediation section for every warning or failure. When colour output is enabled, it SHALL use
semantic status colour and readable symbols; when colour is disabled, the same status and remedy
information MUST remain clear without terminal escape sequences. The report MUST identify the
selected project or global scope and whether remote checks were skipped by offline mode.

#### Scenario: Healthy project doctor result
- **WHEN** every local and applicable remote project check passes
- **THEN** the human report presents a healthy summary, the project scope, and concise passing
  check details without a remediation section

#### Scenario: Doctor result has a warning and a failure
- **WHEN** doctor finds a warning and a local validation failure
- **THEN** the human report identifies the blocked outcome, clearly labels both checks, and lists
  each remediation as a next action

#### Scenario: Colour output is disabled
- **WHEN** a user requests doctor output with colour disabled
- **THEN** the human report has no ANSI styling and retains explicit textual status indicators

### Requirement: Doctor machine-readable behavior remains stable
The system SHALL preserve the structured JSON doctor report, redaction, check status values, and
exit-code precedence for local and remote failures. Human presentation enhancements MUST NOT add
terminal control sequences to JSON output or change a non-interactive invocation into a TUI.

#### Scenario: JSON doctor is consumed by automation
- **WHEN** automation runs `skill-sync doctor --json`
- **THEN** it receives the structured redacted report and the same success, validation, or
  repository exit result as before the human-formatting enhancement
