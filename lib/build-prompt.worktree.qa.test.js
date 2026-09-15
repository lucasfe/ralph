import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { buildPrompt } from './build-prompt.js'
import { buildValidatePrompt } from './build-validate-prompt.js'
import { templatePath } from './paths.js'

// QA augmentation for the #218 half of lib/build-prompt.js — the one behavioural line
// in that file, `PROJECT_ROOT: env.RALPH_PROMPT_PROJECT_ROOT?.trim() || projectRoot`.
//
// lib/build-prompt.test.js owns the seam itself: the override renders, PROMPT.md still
// comes from the main root, and unset/empty/whitespace fall back. Every one of those
// assertions reads the FIRST rendered site, `Your project root is \`X\``. This file
// asks the questions that site cannot answer:
//
//   • {{PROJECT_ROOT}} is not one placeholder, it is FOUR per github template
//     (MEASURED below, in the test, by counting the token in the template source so
//     the number cannot go stale). Two of those four are the "NEVER edit files
//     outside" restrictions — the sentences that decide what the agent believes it is
//     allowed to touch. If the override reached the greeting and not the restrictions,
//     the prompt would name the worktree and then forbid writing to it.
//   • The value is a path this module never checks. What does an unusable one do?
//   • The variable is read UNCONDITIONALLY, unlike its sibling RALPH_TASK_KEY, which
//     `jiraTaskKey` gates on the resolved source on purpose. The divergence is
//     measured here rather than argued about.
//   • The validation prompt renders {{PROJECT_ROOT}} too, from a different module.
//     Does an ambient override reach it?
//
// Same memfs shape as the dev's file: no template is read from the real filesystem by
// the code under test, and nothing here writes anywhere.

const PROJECT = '/project'
const WORKTREE = '/project/.ralph/worktrees/issue-7'

// A github render reaches prompt-team.md (claude) or prompt-team-codex.md (codex);
// resolveAgent reads RALPH_AGENT. Both are exercised, because the placeholder count
// and the restriction wording are per-template facts.
const GITHUB_TEMPLATES = [
  ['claude', {}, 'prompt-team.md'],
  ['codex', { RALPH_AGENT: 'codex' }, 'prompt-team-codex.md'],
]

function makeStderr() {
  const calls = []
  return {
    write: (m) => {
      calls.push(m)
      return true
    },
    calls,
  }
}

function setupFs({ projectFiles = {} } = {}) {
  const names = [
    'prompt-team.md',
    'prompt-team-codex.md',
    'prompt-team-folder.md',
    'prompt-team-jira.md',
    'validate-config.md',
    'roles/dev.md',
    'roles/qa.md',
    'roles/reviewer.md',
    'roles/writer.md',
    'roles/explorer.md',
  ]
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  for (const n of names) vol.writeFileSync(templatePath(n), readFileSync(templatePath(n), 'utf8'))
  vol.mkdirSync(PROJECT, { recursive: true })
  for (const [k, v] of Object.entries(projectFiles)) vol.writeFileSync(join(PROJECT, k), v)
  return vol
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1

// Read from the real templates rather than a fixture: the count under test is a
// property of the shipped file, and re-deriving it here is what keeps the assertions
// below honest when a later slice adds or removes a site.
const templateText = (name) => readFileSync(templatePath(name), 'utf8')

describe('RALPH_PROMPT_PROJECT_ROOT reaches EVERY {{PROJECT_ROOT}} site, not just the greeting (#218 QA)', () => {
  it.each(GITHUB_TEMPLATES)(
    'the %s template renders the worktree at all of its sites and the main root at none',
    (_agent, env, templateName) => {
      // MEASURED, not asserted as a literal: whatever the template's site count is,
      // that is how many times the worktree path must appear.
      const sites = occurrences(templateText(templateName), '{{PROJECT_ROOT}}')
      expect(sites).toBeGreaterThan(1)

      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { ...env, RALPH_PROMPT_PROJECT_ROOT: WORKTREE },
        fs: vol,
      })

      expect(occurrences(out, WORKTREE)).toBe(sites)
      // `/project` is a prefix of the worktree path, so the main root is counted as a
      // whole rendered value — a backtick-quoted `/project` on its own — rather than
      // as a substring, which would match inside the worktree path itself.
      expect(out).not.toContain(`\`${PROJECT}\``)
    },
  )

  it.each(GITHUB_TEMPLATES)(
    'the %s restriction lines name the WORKTREE, so the prompt does not forbid its own tree',
    (_agent, env, templateName) => {
      // The two sentences that matter most: the agent obeys them literally, and before
      // #218 they named the tree it was standing in by definition. Now the greeting and
      // the restrictions have to agree, or the agent is told to stay in a tree it is
      // forbidden to write to.
      const template = templateText(templateName)
      expect(template).toContain('NEVER edit, create, or delete files outside `{{PROJECT_ROOT}}`')

      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { ...env, RALPH_PROMPT_PROJECT_ROOT: WORKTREE },
        fs: vol,
      })
      expect(out).toContain(`NEVER edit, create, or delete files outside \`${WORKTREE}\``)
      expect(out).toContain(`NEVER run Bash commands that touch files outside \`${WORKTREE}\``)
      expect(out).toContain(`Your project root is \`${WORKTREE}\``)
    },
  )

  it.each(GITHUB_TEMPLATES)(
    'the %s worktree step reads as one coherent instruction once rendered',
    (_agent, env) => {
      // Step 3 no longer prepares a branch, it tells the agent where it already is.
      // The claim and the value it refers to are two different sites in the template,
      // so they are checked together.
      const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
      const out = buildPrompt({
        projectRoot: PROJECT,
        env: { ...env, RALPH_PROMPT_PROJECT_ROOT: WORKTREE },
        fs: vol,
      })
      expect(out).toContain(`\`${WORKTREE}\` above is that worktree rather than the main`)
      // And the deleted step is really gone from the rendered text, roles included.
      expect(out).not.toContain('git checkout -b issue-N')
      expect(out).not.toMatch(/Prepare branch/)
    },
  )
})

describe('what an unusable RALPH_PROMPT_PROJECT_ROOT renders as (#218 QA)', () => {
  // The value is interpolated with no validation of any kind: no isAbsolute check, no
  // existence check, and no relationship to projectRoot. That is defensible — the only
  // writer is templates/ralph.sh, which sets it to a path lib/worktree.js just derived
  // and refused to derive unsafely — and these rows pin what "no validation" means, so
  // a later slice that adds a check has a witness for what it changed.
  const rows = [
    ['a relative path', '.ralph/worktrees/issue-7', '.ralph/worktrees/issue-7'],
    ['a path with a space', '/my repo/.ralph/worktrees/issue-7', '/my repo/.ralph/worktrees/issue-7'],
    ['a directory that does not exist', '/nope/issue-7', '/nope/issue-7'],
    // A real path is trimmed at both ends, which is what makes a value captured from a
    // command substitution safe even if it kept a trailing blank.
    ['surrounding whitespace', '  /project/wt  ', '/project/wt'],
  ]

  it.each(rows)('renders %s verbatim after trimming', (_label, value, expected) => {
    const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
    const stderr = makeStderr()
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: { RALPH_PROMPT_PROJECT_ROOT: value },
      fs: vol,
      stderr,
    })
    expect(out).toContain(`Your project root is \`${expected}\``)
    // No warning either way: the module has no opinion about the value.
    expect(stderr.calls).toEqual([])
  })

  it('does not let a value containing a replacement pattern rewrite the prompt', () => {
    // lib/interpolate.js:10 passes a replacer FUNCTION to String.replace, so `$&` and
    // `$1` in the VALUE are literal. Handed a string replacement instead they would
    // expand against the match — the placeholder token itself — and the rendered root
    // would name a different directory than the one the agent was started in.
    const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
    const value = '/project/$&/$1/$$'
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: { RALPH_PROMPT_PROJECT_ROOT: value },
      fs: vol,
    })
    expect(out).toContain(`Your project root is \`${value}\``)
    expect(out).not.toContain('{{PROJECT_ROOT}}')
  })

  it('does not re-expand a value that itself contains a placeholder', () => {
    // One pass over the template, and replacements are not rescanned, so a value that
    // spells a placeholder is inert text rather than a second substitution.
    const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: { RALPH_PROMPT_PROJECT_ROOT: '/x/{{DEV_BRANCH}}' },
      fs: vol,
    })
    expect(out).toContain('Your project root is `/x/{{DEV_BRANCH}}`')
  })
})

describe('the override is NOT gated on the task source, unlike RALPH_TASK_KEY (#218 QA)', () => {
  // Pinned as current behaviour and flagged rather than endorsed. Only github mode
  // gets a worktree in this slice, and templates/ralph.sh exports the variable inside
  // its `[ "$TASK_SOURCE" = "github" ]` arm and unsets it at teardown — so nothing in
  // a ralph-started run can leak it across modes. What is NOT closed is the ambient
  // case: the loop inherits its environment, and a value already exported in the
  // user's shell (or by an outer tool) is read here for every source.
  //
  // The contrast is what makes this worth a test rather than a shrug: `jiraTaskKey`
  // (lib/build-prompt.js) returns '' for any source but jira for exactly this reason,
  // and its own comment says so — "an ambient RALPH_TASK_KEY … cannot reach a github
  // prompt even if a later template edit added the placeholder to one". The two
  // env-sourced values in the same bag are handled by two different rules.
  it.each([
    ['folder', 'prompt-team-folder.md'],
    ['jira', 'prompt-team-jira.md'],
  ])('an ambient override still rewrites the %s prompt root', (source, templateName) => {
    const sites = occurrences(templateText(templateName), '{{PROJECT_ROOT}}')
    const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: {
        TASK_SOURCE: source,
        RALPH_TASK_KEY: 'FOO-1',
        RALPH_PROMPT_PROJECT_ROOT: WORKTREE,
      },
      fs: vol,
    })
    expect(occurrences(out, WORKTREE)).toBe(sites)
    expect(out).toContain(`Your project root is \`${WORKTREE}\``)
  })

  it('while the same ambient RALPH_TASK_KEY is dropped for a non-jira source', () => {
    // The measured half of the contrast above: the key is discarded silently for
    // folder mode, with no warning, because the gate is on the source.
    const vol = setupFs({ projectFiles: { 'PROMPT.md': '' } })
    const stderr = makeStderr()
    const out = buildPrompt({
      projectRoot: PROJECT,
      env: {
        TASK_SOURCE: 'folder',
        RALPH_TASK_KEY: 'FOO-1',
        RALPH_PROMPT_PROJECT_ROOT: WORKTREE,
      },
      fs: vol,
      stderr,
    })
    expect(out).not.toContain('FOO-1')
    expect(stderr.calls).toEqual([])
  })
})

describe('the validation prompt is unaffected by the override (#218 QA)', () => {
  it('renders its own {{PROJECT_ROOT}} sites as the MAIN root with an override set', () => {
    // A different module (lib/build-validate-prompt.js) with its own PROJECT_ROOT var,
    // and it must stay the main root: validation runs before the loop, in the main
    // tree, editing the project's ralph.config.sh — a file no worktree checkout of a
    // half-configured project is guaranteed to have. MEASURED: that module reads no
    // env value other than RALPH_VERSION, so the override cannot reach it; the test
    // sets the variable on process.env for the duration to say so out loud, since the
    // module reads process.env directly rather than an injected bag.
    const sites = occurrences(templateText('validate-config.md'), '{{PROJECT_ROOT}}')
    expect(sites).toBeGreaterThan(0)

    const vol = setupFs({ projectFiles: { 'ralph.config.sh': 'DEV_BRANCH=main\n' } })
    const previous = process.env.RALPH_PROMPT_PROJECT_ROOT
    process.env.RALPH_PROMPT_PROJECT_ROOT = WORKTREE
    try {
      const out = buildValidatePrompt({ projectRoot: PROJECT, fs: vol, ralphVersion: '9.9.9' })
      expect(occurrences(out, PROJECT)).toBeGreaterThanOrEqual(sites)
      expect(out).not.toContain(WORKTREE)
    } finally {
      if (previous === undefined) delete process.env.RALPH_PROMPT_PROJECT_ROOT
      else process.env.RALPH_PROMPT_PROJECT_ROOT = previous
    }
  })
})
