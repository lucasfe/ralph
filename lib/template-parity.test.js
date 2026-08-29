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
  '3. **Prepare branch**',
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
// the folder template promises `The bash pushes {{DEV_BRANCH}} for you after this
// invocation returns`, and MEASURED against templates/ralph.sh that promise is
// false — the word `push` does not appear in that file at all, on any arm. The
// jira template must not inherit it, so the false sentence is pinned on the folder
// side (fixing it is a separate slice) and its absence is pinned on the jira side.
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

  it('does NOT inherit the folder template’s false promise that bash pushes the dev branch', () => {
    // Pinned on BOTH sides so the negative below cannot go stale: the sentence
    // really is in the folder template today (that is the bug the jira template
    // must not copy), and it is nowhere in the jira one.
    expect(folder).toContain('The bash pushes `{{DEV_BRANCH}}` for you after this invocation')
    expect(jira).not.toMatch(/bash pushes/i)
    expect(jira).not.toMatch(/the bash pushes it/i)
    // And it says the true thing instead.
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
