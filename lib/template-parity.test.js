import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { templatePath } from './paths.js'

// #554: the two orchestrator templates must share required structure so a
// one-sided edit fails CI instead of shipping. This asserts external structure
// (placeholders, numbered step headings, the absolute-restrictions block, and
// the PR-body section names) — NOT the orchestrator body, which is deliberately
// forked for how each agent delegates.

const claude = readFileSync(templatePath('prompt-team.md'), 'utf8')
const codex = readFileSync(templatePath('prompt-team-codex.md'), 'utf8')
const folder = readFileSync(templatePath('prompt-team-folder.md'), 'utf8')
const jira = readFileSync(templatePath('prompt-team-jira.md'), 'utf8')

const ROLE_PLACEHOLDERS = [
  '{{ROLE_DEV}}',
  '{{ROLE_QA}}',
  '{{ROLE_REVIEW}}',
  '{{ROLE_WRITER}}',
  '{{ROLE_EXPLORER}}',
]

const VARS = [
  '{{PROJECT_ROOT}}',
  '{{INSTALL_CMD}}',
  '{{TEST_CMD}}',
  '{{LINT_CMD}}',
  '{{MAIN_BRANCH}}',
  '{{DEV_BRANCH}}',
  '{{PR_TARGET}}',
  '{{MERGE_STRATEGY}}',
  '{{MERGE_POLL_INTERVAL}}',
  '{{MERGE_POLL_MAX}}',
  '{{RALPH_HEAVY_TIER}}',
  '{{PROJECT_PROMPT}}',
]

// Numbered step headings that must appear identically in both templates.
const STEP_HEADINGS = [
  '0. **Ensure dependencies**',
  '1. **Select issue**',
  '2. **Mark in progress**',
  '3. **Confirm the worktree**',
  '3b. **Triage and scale the team**',
  '4. **Resolve via the dev specialist**',
  '4b. **Harden via the QA specialist**',
  '4c. **Review via the code reviewer specialist**',
  '4d. **Document via the tech writer specialist**',
  '5. **Validate locally**',
  '6. **Commit + push**',
  '7. **Open PR**',
  '8. **Auto-merge + wait**',
  '9. **Mark complete**',
]

const PR_BODY_SECTIONS = [
  '## Dev/TDD',
  '## QA scenarios added',
  '## Review verdict',
  '## Docs updated',
  '## Notes',
]

describe('template parity — prompt-team.md vs prompt-team-codex.md (#554)', () => {
  it.each(ROLE_PLACEHOLDERS)('both templates compose the %s role placeholder', (p) => {
    expect(claude).toContain(p)
    expect(codex).toContain(p)
  })

  it.each(VARS)('both templates reference the %s variable', (v) => {
    expect(claude).toContain(v)
    expect(codex).toContain(v)
  })

  it.each(STEP_HEADINGS)('both templates carry the numbered step heading "%s"', (h) => {
    expect(claude).toContain(h)
    expect(codex).toContain(h)
  })

  it('both templates carry an identical Absolute restrictions block header', () => {
    expect(claude).toContain('## Absolute restrictions')
    expect(codex).toContain('## Absolute restrictions')
  })

  it.each([
    'NEVER `git push --force`',
    'NEVER push directly to',
    'NEVER `rm -rf` on an absolute path',
    'NEVER merge PRs directly',
    'NEVER close issues manually',
    'NEVER edit, create, or delete files outside',
    'CLAUDE_GIVE_UP',
  ])('both templates enforce the absolute restriction "%s"', (rule) => {
    expect(claude).toContain(rule)
    expect(codex).toContain(rule)
  })

  it.each(PR_BODY_SECTIONS)('both templates share the PR-body section "%s"', (s) => {
    expect(claude).toContain(s)
    expect(codex).toContain(s)
  })

  it('the codex template states the sequential-persona degradation explicitly', () => {
    expect(codex.toLowerCase()).toContain('sequential')
    expect(codex.toLowerCase()).toMatch(/persona/)
  })

  it('the two orchestrator bodies are genuinely distinct (not a copy)', () => {
    expect(codex).not.toBe(claude)
    // The codex template names Codex; the claude one does not lead with it.
    expect(codex).toContain('Codex')
  })
})

// ---------------------------------------------------------------------------
// Dispatch discipline — the CLAUDE-driven templates only
// ---------------------------------------------------------------------------
//
// Claude dispatches subagents as BACKGROUND tasks, so the orchestrator can reach
// the end of its turn with one still in flight; the headless run then terminates
// the session at the background-wait ceiling and the invocation is lost. Both
// claude-driven templates must carry the rule that forbids it.
//
// The codex template is deliberately EXCLUDED: it degrades to sequential personas
// (asserted above), so there is no pending dispatch to orphan and the mechanism
// this rule describes does not exist there.

const CLAUDE_DRIVEN = [
  ['prompt-team.md', claude],
  ['prompt-team-folder.md', folder],
  // #128: the jira orchestrator is derived from the folder one and is driven by
  // the same claude CLI, so the orphaned-dispatch failure mode is identical and
  // the rule has to be carried, not summarized.
  ['prompt-team-jira.md', jira],
]

describe('dispatch discipline — no final message with a subagent in flight', () => {
  it.each(CLAUDE_DRIVEN)('%s carries the Dispatch discipline section', (_name, text) => {
    expect(text).toContain('## Dispatch discipline')
  })

  it.each(CLAUDE_DRIVEN)('%s states that subagents run in the background', (_name, text) => {
    expect(text).toContain('BACKGROUND')
  })

  it.each(CLAUDE_DRIVEN)('%s requires waiting for the notification', (_name, text) => {
    expect(text).toMatch(/WAIT for its completion notification/)
  })

  it.each(CLAUDE_DRIVEN)('%s requires started count to equal finished count', (_name, text) => {
    // Whitespace-tolerant: the sentence wraps across lines differently in the
    // two templates, and the rule is the words, not the line breaks.
    expect(text).toMatch(/Started count must equal\s+finished\s+count/)
  })

  it.each(CLAUDE_DRIVEN)('%s forbids predicting a pending subagent result', (_name, text) => {
    expect(text).toMatch(/Never guess, predict, or write what a pending subagent/)
  })

  it.each(CLAUDE_DRIVEN)('%s repeats the rule as an absolute restriction', (_name, text) => {
    const restrictions = text.slice(text.indexOf('## Absolute restrictions'))
    expect(restrictions).toContain(
      'NEVER emit your final message while a dispatched subagent is still',
    )
  })

  it('the section comes BEFORE the required sequence, not buried after it', () => {
    // It governs every dispatch step, so the orchestrator must read it first.
    for (const [, text] of CLAUDE_DRIVEN) {
      expect(text.indexOf('## Dispatch discipline')).toBeLessThan(
        text.indexOf('## Required sequence'),
      )
    }
  })

  it('the codex template does NOT carry it (sequential personas, nothing to orphan)', () => {
    expect(codex).not.toContain('## Dispatch discipline')
  })

  it.each(CLAUDE_DRIVEN)('%s keeps the paragraph that names the real cost', (_name, text) => {
    // The rule is obeyed because of THIS paragraph, not because of the rule: three
    // invocations died with one more subagent STARTED than FINISHED, and a template
    // that keeps the instruction but drops the evidence is the one an orchestrator
    // talks itself out of.
    expect(text).toContain('This has already cost real work.')
    expect(text).toMatch(/one more subagent STARTED than FINISHED/)
  })
})

// ---------------------------------------------------------------------------
// Jira carry-over — prompt-team-jira.md vs prompt-team-folder.md (#128)
// ---------------------------------------------------------------------------
//
// The jira orchestrator is DERIVED from the folder one because the two share a
// delivery shape: direct commit to {{DEV_BRANCH}}, no feature branch, no PR, no
// auto-merge. What is asserted here is the carry-over — the machinery that has to
// arrive intact — plus the ONE place the two deliberately disagree.
//
// The disagreement is the reason this describe exists rather than a shared list:
// the templates differ in how they name the work (a task file versus a ticket) and
// in what they may promise about the branch. Neither may promise a PUSH: no arm of
// templates/ralph.sh runs one, which the push test below asserts against that file
// rather than trusting either template's prose.
const JIRA_SHARED_VARS = [
  '{{PROJECT_ROOT}}',
  '{{INSTALL_CMD}}',
  '{{TEST_CMD}}',
  '{{LINT_CMD}}',
  '{{MAIN_BRANCH}}',
  '{{DEV_BRANCH}}',
  '{{RALPH_HEAVY_TIER}}',
  '{{TASK_SOURCE}}',
  '{{PROJECT_PROMPT}}',
]

// The PR/auto-merge knobs. Neither commit-direct template may reference one: a
// template that interpolated a merge strategy would be describing a flow its own
// mode does not have.
const PR_ONLY_VARS = [
  '{{PR_TARGET}}',
  '{{MERGE_STRATEGY}}',
  '{{MERGE_POLL_INTERVAL}}',
  '{{MERGE_POLL_MAX}}',
]

const JIRA_SHARED_HEADINGS = [
  '0. **Ensure dependencies**',
  '3. **Prepare working tree**',
  '3b. **Triage and scale the team**',
  '## Tier 2 / Heavy — understand phase (explorer fan-out + inline synthesis)',
  '### Synthesizer seam',
  '4. **Resolve via the dev specialist**',
  '4b. **Harden via the QA specialist**',
  '4c. **Review via the code reviewer specialist**',
  '## Tier 2 / Heavy — verify phase (3-reviewer adversarial panel, majority block)',
  '4d. **Document via the tech writer specialist**',
  '5. **Validate locally**',
  '## Absolute restrictions',
]

const COMMIT_SUMMARY_SECTIONS = [
  '## Dev/TDD',
  '## QA scenarios added',
  '## Review verdict',
  '## Docs updated',
  '## Notes',
]

describe('jira orchestrator carry-over — prompt-team-jira.md vs prompt-team-folder.md (#128)', () => {
  it.each(ROLE_PLACEHOLDERS)('both commit-direct templates compose %s', (p) => {
    expect(folder).toContain(p)
    expect(jira).toContain(p)
  })

  it.each(JIRA_SHARED_VARS)('both commit-direct templates reference %s', (v) => {
    expect(folder).toContain(v)
    expect(jira).toContain(v)
  })

  it.each(PR_ONLY_VARS)('neither commit-direct template references %s', (v) => {
    expect(folder).not.toContain(v)
    expect(jira).not.toContain(v)
  })

  it.each(JIRA_SHARED_HEADINGS)('both commit-direct templates carry "%s"', (h) => {
    expect(folder).toContain(h)
    expect(jira).toContain(h)
  })

  it.each(COMMIT_SUMMARY_SECTIONS)('both commit-direct templates share "%s"', (s) => {
    expect(folder).toContain(s)
    expect(jira).toContain(s)
  })

  it('names the ticket through the {{RALPH_TASK_KEY}} placeholder, which folder mode has no use for', () => {
    expect(jira).toContain('{{RALPH_TASK_KEY}}')
    expect(folder).not.toContain('{{RALPH_TASK_KEY}}')
  })

  it('promises a push in NEITHER template, because no arm of the loop performs one', () => {
    // This pin used to read the other way round: `The bash pushes {{DEV_BRANCH}} for
    // you after this invocation returns` was pinned PRESENT in the folder template — a
    // known-false promise a later slice would fix — and absent from the jira one, which
    // must not inherit it. #221 is that later slice, so both sides are now the absence.
    // The anti-inheritance guard is unchanged in force: what it ever protected is the
    // jira template, and that is still asserted here, without the folder template
    // having to keep a sentence its own step 3 contradicts.
    //
    // Asserted against the bash rather than as a banned string, so it stays honest if a
    // slice ever does add a push. Comment lines are prose about the code, not code, so a
    // `#` mention of push is not a push — the same reduction test/loop.worktree.test.js
    // applies before grepping the loop for behaviour.
    const loopCode = readFileSync(templatePath('ralph.sh'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(loopCode).not.toMatch(/(^|\s)git\s+push/)
    for (const [name, template] of [
      ['folder', folder],
      ['jira', jira],
    ]) {
      expect(template, name).not.toMatch(/bash pushes/i)
      expect(template, name).not.toMatch(/the bash pushes it/i)
    }
    // And the jira one says the true thing instead.
    expect(jira).toMatch(/commit stays local/i)
  })

  it('swaps the folder-only hitl lane for the do-not-ralph label in the restrictions', () => {
    const jiraRestrictions = jira.slice(jira.indexOf('## Absolute restrictions'))
    expect(folder.slice(folder.indexOf('## Absolute restrictions'))).toContain('.ralph/tasks/hitl/')
    expect(jiraRestrictions).not.toContain('.ralph/tasks/hitl/')
    expect(jiraRestrictions).toContain('do-not-ralph')
    // Both modes open no PRs, and both say so.
    expect(jiraRestrictions).toMatch(/NEVER merge PRs directly/)
    expect(jiraRestrictions).toMatch(/opens no PRs|open.{0,20}PR/i)
  })

  it('carries no `.ralph/tasks/` reference at all — every task path became the ticket', () => {
    expect(folder).toContain('.ralph/tasks/')
    expect(jira).not.toContain('.ralph/tasks/')
  })
})

// ---------------------------------------------------------------------------
// Folder mode runs in a detached worktree — prompt-team-folder.md (#221)
// ---------------------------------------------------------------------------
//
// Folder tasks commit straight to {{DEV_BRANCH}}, and git will not check one
// branch out twice. MEASURED on git 2.50.1 (Apple Git-155), second worktree on
// an already-checked-out branch:
//
//   $ git worktree add -B main ../wt-main main
//   fatal: 'main' is already used by worktree at '/private/var/.../r'
//
//   $ git worktree add --detach ../wt-det main
//   Preparing worktree (detached HEAD 0d71546)
//   $ git -C ../wt-det rev-parse --abbrev-ref HEAD
//   HEAD
//   $ git branch --list
//   * main                       <- --detach created no branch
//
// So folder mode gets a DETACHED worktree and the loop moves {{DEV_BRANCH}}
// afterwards. Two consequences land in this template: the agent must no longer
// check the branch out itself, and its task files live in the MAIN repo root's
// gitignored .ralph/tasks/ — outside the worktree it is running in. Those two
// roots are different paths in folder mode, so every task path needs
// {{MAIN_REPO_ROOT}} and every code path keeps {{PROJECT_ROOT}}.
describe('folder mode runs in a detached worktree — prompt-team-folder.md (#221)', () => {
  const folderRestrictions = folder.slice(folder.indexOf('## Absolute restrictions'))

  it('no longer tells the agent to check the dev branch out and pull it', () => {
    // The loop already prepared the tree at the LOCAL {{DEV_BRANCH}} tip. A
    // checkout would fail (branch busy in the main tree) and a pull would base
    // the work on origin, silently dropping the previous iteration's local
    // commit — this source never pushes.
    expect(folder).not.toContain('git checkout {{DEV_BRANCH}} && git pull')
    expect(folder).not.toMatch(/git\s+checkout/)
    expect(folder).not.toMatch(/git\s+pull/)
  })

  it('keeps the step 3 heading but describes the prepared detached tree instead', () => {
    expect(folder).toContain('3. **Prepare working tree**')
    const step3 = folder.slice(folder.indexOf('3. **Prepare working tree**'), folder.indexOf('3b. **Triage'))
    expect(step3).toMatch(/detached/i)
    expect(step3).toMatch(/\{\{DEV_BRANCH\}\}/)
    // The one thing the agent must not do on a detached HEAD.
    expect(step3).toMatch(/create no branch|creating .{0,20}branch is forbidden|switch to none/i)
    // And the truth about who moves the branch.
    expect(step3).toMatch(/advance|park/i)
  })

  it('reaches the task lanes through {{MAIN_REPO_ROOT}}, not the worktree it runs in', () => {
    expect(folder).toContain('{{MAIN_REPO_ROOT}}')
    expect(folder).toContain('{{MAIN_REPO_ROOT}}/.ralph/tasks/')
  })

  it('leaves no bare `.ralph/tasks/` path behind — each one is rooted at the main repo', () => {
    // Every occurrence must be immediately preceded by `{{MAIN_REPO_ROOT}}/`.
    // A bare one would send the agent to the worktree's own .ralph/, which has
    // no tasks in it, so the whole invocation would find nothing to do.
    const bare = folder
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes('.ralph/tasks/'))
      .flatMap(([n, line]) => {
        const hits = []
        let at = line.indexOf('.ralph/tasks/')
        while (at !== -1) {
          if (!line.slice(0, at).endsWith('{{MAIN_REPO_ROOT}}/')) hits.push(`${n}: ${line.trim()}`)
          at = line.indexOf('.ralph/tasks/', at + 1)
        }
        return hits
      })
    expect(bare).toEqual([])
  })

  it('carves the afk task lane out of the stay-inside-{{PROJECT_ROOT}} restriction', () => {
    // Without the carve-out the restrictions contradict steps 1, 2 and 6: the
    // agent is ordered to move files it is also forbidden to touch.
    expect(folderRestrictions).toMatch(/\{\{PROJECT_ROOT\}\}/)
    expect(folderRestrictions).toContain('{{MAIN_REPO_ROOT}}/.ralph/tasks/')
    // The exception is the afk lane only. hitl/ stays off-limits.
    expect(folderRestrictions).toContain('.ralph/tasks/hitl/')
  })
})
