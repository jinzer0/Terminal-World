# Architect Review — review pass 1

- Reviewer: 11-TerminalWorldArchitect (architect)
- architecturalStatus: BLOCK
- decision: REQUEST CHANGES
- sourcePlanner.path: /Users/kjy/Desktop/Codes/projects/Terminal-World/.gjc/_session-01a16445-c707-7474-a132-5bb7a1c81745/plans/ralplan/01a16445-c707-7474-a132-5bb7a1c81745/stage-03-planner.md
- sourcePlanner.sha256: [REDACTED]
- sourcePlanner.stage_n: 3
- Source assessment: agent://11-TerminalWorldArchitect, reviewed and returned by the actual architect lane. Parent is persisting the assessment through the successful native cwd transport, not issuing a substitute architecture judgment. Role's required explicit-root write failed exit 2: `ralplan --worktree-root is not a valid git worktree: /Users/kjy/Desktop/Codes/projects/Terminal-World`; role issued no receipt. No root flag was omitted by that role; no commit/force/direct write occurred.

## Typed findings
- findingId: ARCH-01
- targetId: T02
- action: change
- severity: HIGH
- sourceRole: architect
- blocking: true
- Title: Disable Ink automatic Ctrl+C exit and assign one pending-aware shutdown owner.
- Evidence: reviewed plan T02 and keyboard/storage shutdown clauses promise pending result before unmount/lock release but do not explicitly disable Ink automatic exit. Ink8 render.js defaults exitOnCtrlC=true; hooks/use-input.js does not forward Ctrl+C to the app input handler under that setting; components/App.js performs internal exit first. Sources: https://unpkg.com/ink@8.0.0/build/render.js ; https://unpkg.com/ink@8.0.0/build/hooks/use-input.js ; https://unpkg.com/ink@8.0.0/build/components/App.js . This is a documented configuration hazard, not measured data loss.
- Required fix: explicitly render with exitOnCtrlC:false. Ctrl+C and SIGTERM use one idempotent requestShutdown. Await any pending commit before unmount, terminal restoration and lock release. G3/V3 must exercise actual render configuration with deferred commit + Ctrl+C/SIGTERM and verify ordering and no repeated cleanup.

## Antithesis and synthesis
JSON requires explicit lock/revision/sync/rename-uncertainty handling, so SQLite could reduce correctness code. For this bounded single-writer <=16 MiB prototype, no concrete net gain over native-driver/runtime/distribution costs was established. Keep O1/T05; do not reopen storage or TS+Ink. Narrow correction to T02 and its tests. Prefer Ink8 input/paste APIs and introduce a T10 stream adapter only if M0 evidence requires it.

## Remaining assessment
Mouse/Unicode compatibility is explicitly future-gated in M0/G1/G2, not falsely claimed proven; this is not an additional blocker. Keep mouse and user-preauthorized objectively-impossible fallback without asking again. Personal theme/target guestbook boundaries and no-SSH/auth/network/auto-reply/board/timer/editor/collaboration scope are sound. Precompiled JS/Node shebang/private tarball verification satisfies the stated npm/Bun tooling contract without claiming Bun-native or registry publication. Only ARCH-01 is required.

## Verification boundary
Reviewer performed read-only document/ledger/public-source review. No product change, installation, experiments, tests, build, lint, format, git mutation or future verification gate ran.
