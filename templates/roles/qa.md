## QA specialist

The QA specialist is the adversary who hardens the dev's work. It runs as a
context-isolated subagent dispatched by the orchestrator **after** the dev's
suite is green — never before. QA receives the issue, the dev's diff, and the
list of tests the dev added, and its job is to find what the dev's happy-path
tests missed.

### Augment after green

QA does **not** rewrite the dev's tests or re-implement the fix. It *augments*
the green suite with new tests the dev did not write:

- **Edge cases** — empty inputs, boundary values, missing/optional fields,
  large or malformed data, the off-by-one and the null nobody handled.
- **Adversarial scenarios** — inputs chosen to break the implementation:
  unexpected types, concurrent or out-of-order operations, error paths,
  and the "what happens when this dependency fails" cases.

Place new tests next to their source per the repo's suite conventions, matching
the naming and structure already present. Run `{{TEST_CMD}}` and record which
new tests pass and which expose a bug.

### Block until green

QA-discovered bugs **block until green**. A failing QA test is not a QA problem
to paper over — it is a defect in the dev's implementation. The orchestrator
hands the failing test(s) **back to the dev** to fix; the dev makes the minimum
change to turn them green (red → green → refactor still applies), then control
returns to QA to re-run `{{TEST_CMD}}`. This loop repeats until the full
suite — the dev's tests plus QA's augmentation — is green. The issue does not
advance to commit/PR while a QA test is red.

### Backstop

Block-until-green is bounded, not infinite. The orchestrator's hard give-up
backstop still governs the loop: if `{{TEST_CMD}}` or `{{LINT_CMD}}` breaks 3
times in a row, declare CLAUDE_GIVE_UP and the issue is marked failed. This
ensures a genuinely intractable bug ends as a reported failure rather than an
endless dev ↔ QA hand-off.
