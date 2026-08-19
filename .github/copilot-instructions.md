# Workspace Agent Instructions

## Required Work Plan

- Follow [work-plan.md](work-plan.md) for every repository task.
- Treat its phases as an execution sequence, not optional suggestions; pause and reassess when a phase's check fails.

## Resource Management

- Start from the smallest concrete anchor: a named file, symbol, failing command, test, or observed behavior.
- Gather only the local context needed to form one falsifiable hypothesis and identify one cheap check that can disconfirm it.
- Prefer targeted search and nearby reads over broad repository mapping. Stop exploring once the controlling code path is clear.
- Use parallel read-only operations when they are independent. Keep tool output focused and avoid redundant reads.
- Preserve the existing worktree. Never discard, reset, or overwrite changes that were not made for the current task.
- Keep edits minimal, local, and consistent with existing APIs and conventions.

## Dividing Work

- Divide work by ownership boundary: exploration, implementation, and validation should have distinct goals and clear inputs and outputs.
- Use a read-only subagent for uncertain or broad codebase exploration; ask it to return relevant files, symbols, behavior, and test commands without editing.
- Parallelize independent investigation or validation tasks. Do not parallelize edits to the same file or dependent steps.
- Before delegating, define the exact question, scope, and expected result. Do not delegate work that is faster to do locally.
- After delegated work returns, verify its conclusions against the owning code path before editing.

## Editing and Validation

- Before the first edit, state the local hypothesis, discriminating check, and smallest edit that will test it.
- Use `apply_patch` for modifications to existing text files and preserve surrounding formatting.
- After the first substantive edit, immediately run the narrowest executable check available for the touched behavior.
- If that check fails, repair the same slice and rerun it before expanding scope.
- Finish with at least one post-edit executable validation step; report unavailable or unrelated failures separately.
- Do not commit or create branches unless explicitly requested.
