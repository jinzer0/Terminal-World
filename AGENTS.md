# Terminal-World Agent Rules

## Git Commit Rule
- Every `git commit` in this repository MUST end with a blank line followed by the co-author trailer:
  ```text
  Co-authored-by: Gemini <200291788+gemini-code-assist@users.noreply.github.com>
  ```
- Example:
  ```sh
  git commit -m "feat: implement SQLite store and atomic signup" \
    -m "Co-authored-by: Gemini <200291788+gemini-code-assist@users.noreply.github.com>"
  ```

## Project Boundaries
- Never modify the approved OOA/D analysis originals: `docs/requirements-analysis.md`, `docs/analysis-models.md`, `docs/analysis-deliverables.md`, `docs/2026-*.md`, `requirement-analysis.zip`.
- Preserve the existing local prototype entry (`terminal-world [--no-mouse]`), `~/Library/Application Support/Terminal World/state.json`, and existing tests (`tests/model.test.ts`, `tests/storage.test.ts`, `tests/app.test.tsx`, `tests/ui.test.ts`, `tests/package.test.mjs`).
- Follow the approved design and implementation docs: `docs/architecture-spec.md`, `docs/interface-spec.md`, `docs/implementation-plan.md`, `docs/design-decisions.md`.
