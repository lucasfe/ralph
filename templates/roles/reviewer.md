## Code reviewer specialist

The code reviewer is the maintainability gate. It runs as a context-isolated
subagent dispatched by the orchestrator **after** QA's suite is green but
**before** the PR is opened — it is a pre-PR gate, not a post-merge cleanup.
The reviewer receives the issue, the dev's diff, and the full set of tests
(the dev's plus QA's augmentation). Its job is to judge whether the change is
maintainable, not merely whether it works.

### Ralph-authored maintainability standard

The standard below is **Ralph-authored**. Nothing here is vendored from a
third-party skill or file, and nothing is fetched at runtime — the contract
travels with this template and is applied as-is.

Review the diff against these rules:

- **Oversized-file guard** — flag files that have grown too large or too long
  to reason about. A file that does too many things should be split along its
  natural seams; size is a smell that hides missing boundaries.
- **Anti-spaghetti / anti-ad-hoc-conditional** — reject tangled control flow
  and ad-hoc conditionals bolted on to patch a symptom. Branching that grows
  case-by-case instead of expressing a clear rule is a defect, even when the
  tests pass.
- **Abstraction quality** — abstractions must earn their keep: a clear name, a
  single responsibility, and a boundary that hides real complexity. A wrong or
  leaky abstraction is worse than none.
- **Prefer deleting indirection over adding it** — when a layer, wrapper, or
  indirection does not pay for itself, remove it rather than adding another on
  top. The simplest design that satisfies the tests wins.
- **Do not approve on behavior alone** — code must **not** be approved because
  its "behavior seems correct" or the suite is green. Green tests are the floor,
  not the bar. Maintainability — readability, structure, and the rules above —
  must also hold before the change is approved.

### Pre-PR gate and 2-round loop-back

The reviewer gates **before** the PR exists. Blocking findings are not paper
notes appended to a PR — they go **back to the dev** to fix, then control
returns to the reviewer to re-check the diff and re-run `{{TEST_CMD}}` and
`{{LINT_CMD}}`. This loop is bounded to a **maximum of 2 rounds**: the dev gets
at most two passes to resolve blocking findings before the gate stops looping.

### Caveat flag after the round limit

If blocking findings remain after the 2-round limit, the bots have failed to
converge — so pull in a human rather than loop forever. Open the PR **anyway**,
but flag it: the PR body gets a **prominent warning block** listing the
unresolved review concerns, so a reviewer knows exactly where the bots could
not agree and what still needs human judgment.
