# Project Guidelines

## Scope
These instructions apply to all files in this workspace.

## Code Style
- Match existing style in the file you edit (naming, formatting, and project patterns).
- Prefer small, focused changes over broad refactors.
- Avoid introducing new dependencies unless they are clearly justified.

## Architecture
- Keep feature logic, infrastructure code, and shared utilities clearly separated.
- Favor modular design with explicit boundaries between components.
- Add lightweight docs for non-obvious design decisions.

## Build and Test
- Before opening a pull request, run the project's standard format, lint, and test commands once they are defined.
- If a command is missing, add it to project documentation and avoid guessing hidden workflows.

## Conventions
- Link to detailed docs instead of duplicating large guidance blocks in this file.
- Document project-specific patterns in docs as they emerge (for example: docs/architecture.md, docs/testing.md, docs/contributing.md).
- Keep this file short and update it as the repository evolves.
