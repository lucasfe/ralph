import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPrompt } from './build-prompt.js'
import { buildValidatePrompt } from './build-validate-prompt.js'
import { templatePath } from './paths.js'

// QA augmentation for #221's {{MAIN_REPO_ROOT}}. lib/build-prompt.test.js pins the folder
// render (both roots, no leftover token, no warning) and lib/template-parity.test.js pins
// the folder TEMPLATE's use of it. What neither covers is the placeholder as a MEMBER OF THE
// BAG, which is a property of every render rather than of one template:
//
//   • It is unconditional, so a template that starts naming it in ANOTHER source's prompt
//     must not produce `⚠️  interpolate: unknown placeholder {{MAIN_REPO_ROOT}}` and a raw
//     token in what the agent reads. That is the exact red the dev's folder test was
//     written for; here it is asked of github/claude, github/codex and jira too, driven
//     through a STUB template so the assertion is about the bag and cannot go green (or
//     red) because of an unrelated edit to real prose.
//   • It must be un-overridable from the environment. It names the checkout that owns the
//     gitignored `.ralph/tasks/` queue, so an ambient value would point the agent's `mv`
//     commands at another directory entirely.
//   • Its value is a PATH, i.e. foreign text, and interpolate() substitutes with a function
//     callback — so `$&`, `$1` and even a `{{…}}`-looking directory name have to survive
//     verbatim and unexpanded.
//
// A stub template rather than the real ones for those three: what is under test is
// lib/build-prompt.js's bag, and reading the shipped prose would make this file fail every
// time somebody rewords a step.

const PROJECT = '/project'
const WORKTREE = '/project/.ralph/worktrees/task-7'

function makeStderr() {
  const calls = []
  return { write: (m) => calls.push(m), calls }
}

// Every template lib/build-prompt.js can select, replaced by the SAME stub — one line per
// var of interest plus the role markers, so a render can be compared across sources.
const STUB = [
  'PROJECT_ROOT=[{{PROJECT_ROOT}}]',
  'MAIN_REPO_ROOT=[{{MAIN_REPO_ROOT}}]',
  'TASK_SOURCE=[{{TASK_SOURCE}}]',
  'TASKS=[{{MAIN_REPO_ROOT}}/.ralph/tasks/afk/todo/]',
  '{{ROLE_DEV}}{{ROLE_QA}}{{ROLE_REVIEW}}{{ROLE_WRITER}}{{ROLE_EXPLORER}}',
  '',
].join('\n')

const TEMPLATES = [
  'prompt-team.md',
  'prompt-team-codex.md',
  'prompt-team-folder.md',
  'prompt-team-jira.md',
]

function stubFs({ projectFiles = {} } = {}) {
  const vol = Volume.fromJSON({}, '/')
  vol.mkdirSync(templatePath('roles'), { recursive: true })
  for (const name of TEMPLATES) vol.writeFileSync(templatePath(name), STUB)
  for (const role of ['dev', 'qa', 'reviewer', 'writer', 'explorer']) {
    vol.writeFileSync(templatePath(`roles/${role}.md`), '')
  }
  vol.mkdirSync(PROJECT, { recursive: true })
  for (const [k, v] of Object.entries(projectFiles)) vol.writeFileSync(join(PROJECT, k), v)
  return vol
}

const render = (env, { projectRoot = PROJECT, stderr = makeStderr(), vol = stubFs() } = {}) => ({
  out: buildPrompt({ projectRoot, env, fs: vol, stderr }),
  stderr,
})

const field = (out, name) => out.match(new RegExp(`^${name}=\\[(.*)\\]$`, 'm'))?.[1]

// Each source/agent pair the builder can resolve, spelled as the env that selects it.
const RENDERS = [
  ['github + claude', {}],
  ['github + codex', { RALPH_AGENT: 'codex' }],
  ['folder', { TASK_SOURCE: 'folder' }],
  ['folder + codex', { TASK_SOURCE: 'folder', RALPH_AGENT: 'codex' }],
  ['jira', { TASK_SOURCE: 'jira', RALPH_TASK_KEY: 'FOO-123' }],
  ['an unrecognised source', { TASK_SOURCE: 'nonsense' }],
]

describe('MAIN_REPO_ROOT is in the bag for every render, not just folder mode (#221 QA)', () => {
  it.each(RENDERS)('resolves it with no warning and no leftover token for %s', (_label, env) => {
    const { out, stderr } = render(env)
    expect(field(out, 'MAIN_REPO_ROOT')).toBe(PROJECT)
    expect(out).not.toMatch(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/)
    expect(stderr.calls.join('')).not.toContain('MAIN_REPO_ROOT')
  })

  it.each(RENDERS)('keeps it equal to {{PROJECT_ROOT}} with no override, for %s', (_label, env) => {
    // The asymmetry only exists where it must: with no worktree in play the two names are
    // the same path, so a template may use either one without a per-source special case.
    const { out } = render(env)
    expect(field(out, 'MAIN_REPO_ROOT')).toBe(field(out, 'PROJECT_ROOT'))
  })

  it.each(RENDERS)('keeps it on the MAIN root when the loop overrides the project root, for %s', (_label, env) => {
    // github mode has had the override since #218 and folder mode got one in #221, so this
    // is asked of every source: the two must come apart, and only in this direction.
    const { out } = render({ ...env, RALPH_PROMPT_PROJECT_ROOT: WORKTREE })
    expect(field(out, 'PROJECT_ROOT')).toBe(WORKTREE)
    expect(field(out, 'MAIN_REPO_ROOT')).toBe(PROJECT)
    expect(out).toContain(`TASKS=[${PROJECT}/.ralph/tasks/afk/todo/]`)
  })
})

describe('MAIN_REPO_ROOT cannot be redirected by the environment (#221 QA)', () => {
  it.each([
    ['MAIN_REPO_ROOT', '/somewhere/else'],
    ['RALPH_PROMPT_MAIN_REPO_ROOT', '/somewhere/else'],
    ['RALPH_MAIN_REPO_ROOT', '/somewhere/else'],
    ['PROJECT_ROOT', '/somewhere/else'],
  ])('ignores an ambient %s', (name, value) => {
    // It is this process's own cwd by construction — the loop cd's to the main root once at
    // startup and the prompt builder runs there — so no env var may name it. `PROJECT_ROOT`
    // is on the list because ralph.sh exports it for OTHER consumers (the codex sandbox
    // flag reads it), and a bag that read it here would let one export move both roots.
    const { out } = render({ TASK_SOURCE: 'folder', [name]: value })
    expect(field(out, 'MAIN_REPO_ROOT')).toBe(PROJECT)
    expect(out).not.toContain('/somewhere/else')
  })

  it.each([
    ['blank', ''],
    ['whitespace only', '   '],
    ['a lone tab', '\t'],
  ])('falls back to the main root when the worktree override is %s', (_label, override) => {
    // bash exports an unset variable as '', and `unset` after an iteration is not the only
    // path out of the loop — so a blank override must mean "no worktree", not "the project
    // root is the empty string".
    const { out } = render({ TASK_SOURCE: 'folder', RALPH_PROMPT_PROJECT_ROOT: override })
    expect(field(out, 'PROJECT_ROOT')).toBe(PROJECT)
    expect(field(out, 'MAIN_REPO_ROOT')).toBe(PROJECT)
  })

  it('trims a padded override rather than naming a path with spaces around it', () => {
    const { out } = render({
      TASK_SOURCE: 'folder',
      RALPH_PROMPT_PROJECT_ROOT: `  ${WORKTREE}  `,
    })
    expect(field(out, 'PROJECT_ROOT')).toBe(WORKTREE)
  })
})

describe('both roots are substituted as literal text, never re-scanned (#221 QA)', () => {
  it.each([
    ['a dollar-ampersand', '/tmp/$& weird'],
    ['a capture reference', '/tmp/$1$2'],
    ['a dollar-brace', '/tmp/${HOME}'],
    ['a backslash escape', '/tmp/back\\slash'],
    ['a placeholder-looking directory', '/tmp/{{DEV_BRANCH}}'],
  ])('renders %s in a path verbatim', (_label, weird) => {
    // interpolate() replaces through a FUNCTION callback, so `$&` and `$1` are not
    // treated as replacement patterns and the substituted text is never scanned for
    // placeholders of its own. Both matter here: a project path is foreign text, and
    // {{MAIN_REPO_ROOT}} is used to build the `mv` commands the agent runs.
    const { out } = render(
      { TASK_SOURCE: 'folder', RALPH_PROMPT_PROJECT_ROOT: weird },
      { projectRoot: weird },
    )
    expect(field(out, 'PROJECT_ROOT')).toBe(weird)
    expect(field(out, 'MAIN_REPO_ROOT')).toBe(weird)
    expect(out).toContain(`TASKS=[${weird}/.ralph/tasks/afk/todo/]`)
    // No expansion of any kind happened on the way in.
    expect(out).not.toContain('/tmp/main/')
    expect(out).not.toContain(process.env.HOME ?? ' never')
  })

  it('does not warn about a placeholder that came in through a path', () => {
    // The `{{DEV_BRANCH}}` in the row above is DATA, and the warning stream must not
    // report it as an unknown placeholder in the template — that would send a reader
    // looking for a template bug that does not exist.
    const { out, stderr } = render(
      { TASK_SOURCE: 'folder', RALPH_PROMPT_PROJECT_ROOT: '/tmp/{{NOT_A_VAR}}' },
      { projectRoot: PROJECT },
    )
    expect(out).toContain('/tmp/{{NOT_A_VAR}}')
    expect(stderr.calls.join('')).toBe('')
  })
})

describe('the validation prompt has no main-root placeholder to resolve (#221 QA)', () => {
  it('renders templates/validate-config.md with no unresolved token', () => {
    // buildValidatePrompt's bag is three vars — PROJECT_ROOT, CURRENT_CONFIG_HASH,
    // RALPH_VERSION — and {{MAIN_REPO_ROOT}} is NOT one of them. That is correct today
    // (the validation pass runs in the main tree, so there is one root and no worktree),
    // but it means the shipped template must never name the new placeholder: it would
    // render as a raw `{{MAIN_REPO_ROOT}}` token plus a warning. Guarded here rather than
    // in prose, using the REAL template because that is the artefact at risk.
    const template = readFileSync(templatePath('validate-config.md'), 'utf8')
    expect(template).not.toContain('{{MAIN_REPO_ROOT}}')

    const vol = Volume.fromJSON({}, '/')
    vol.mkdirSync(templatePath('.'), { recursive: true })
    vol.writeFileSync(templatePath('validate-config.md'), template)
    vol.mkdirSync(PROJECT, { recursive: true })
    vol.writeFileSync(join(PROJECT, 'ralph.config.sh'), 'DEV_BRANCH=main\n')
    const stderr = makeStderr()
    const out = buildValidatePrompt({
      projectRoot: PROJECT,
      ralphVersion: '0.26.0',
      fs: vol,
      stderr,
    })
    expect(out).not.toMatch(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/)
    expect(stderr.calls).toEqual([])
  })
})
