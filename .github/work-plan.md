# AI Work Plan

Follow these phases for every repository task. Keep the task within the smallest scope that can satisfy the request.

## 1. Understand

- Identify the requested outcome and the smallest concrete anchor.
- Inspect only the owning file, symbol, test, command, or nearby call site.
- Record one local hypothesis about the behavior and one cheap check that could disconfirm it.

## 2. Route

- Find the code that directly decides, mutates, or controls the behavior.
- Choose the narrowest existing abstraction and follow local conventions.
- Stop reading once the hypothesis and validation check are grounded.

## 3. Partition

- Separate exploration, implementation, and validation into distinct work units.
- Delegate only uncertain or broad read-only exploration, with a precise question and bounded scope.
- Run independent read-only checks in parallel; keep dependent work sequential.
- Never assign concurrent edits to the same file or overlapping behavior.

## 4. Change

- State the hypothesis, check, and smallest intended edit before modifying files.
- Preserve unrelated user changes and public APIs.
- Make the smallest reversible patch that tests the hypothesis.
- Avoid unrelated cleanup, new abstractions, or metadata churn.

## 5. Verify

- Immediately run the narrowest executable check after the first substantive edit.
- If it fails, repair the same slice and rerun the same check before expanding scope.
- Add or update focused tests when the behavior has a suitable test boundary.
- Finish with a post-edit executable check and distinguish task failures from pre-existing failures.

## 6. Report

- Summarize what changed, why it addresses the request, and what validation passed.
- Link changed files using workspace-relative paths.
- State remaining risks, unavailable checks, or follow-up work plainly.
