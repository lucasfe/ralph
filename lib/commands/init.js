import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  writeFileSync as realWriteFileSync,
  mkdirSync as realMkdirSync,
  chmodSync as realChmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { detectStack } from '../detect-stack.js'
import { templatePath } from '../paths.js'
import { resolveAgent, VALID_AGENTS } from '../agent-registry.js'
import { VALID_SOURCES, DEFAULT_SOURCE } from '../task-source.js'
// #108 — one line per warning, whatever the user typed at the flag. See lib/one-line.js.
import { oneLineEcho } from '../one-line.js'
// #133 (QA round 1): the repo's SHARED template substitution, in place of the private
// `split('{{KEY}}').join(value)` loop this file used to carry. That loop ran once per
// key over text that already held the previous keys' values, so a value containing the
// literal text of a LATER key's placeholder had that key's value substituted INTO it on
// the following pass. With JIRA_JQL now pre-quoted by `quoteConfigValue`, the damage was
// exactly the shape #133 exists to prevent — measured, `JIRA_JQL="project = "Ready for
// Release""`, which leaves JIRA_JQL unset in the sourcing shell and runs `for` as a
// command, while `parseConfigVar` reads a value off the same line. This helper scans the
// template ONCE with a placeholder regex and never re-examines what it substituted, so
// the property holds for every key rather than for the two that happened to bite; its
// `{{NAME}}` pattern covers all ten placeholders templates/ralph.config.sh carries, and
// the emitted bytes are identical for every value that does not name a placeholder
// (measured against the old loop over the real template before the swap).
import { interpolate } from '../interpolate.js'
import { confirm, promptValue as defaultPromptValue } from '../utils/prompt.js'
import { parseEnvFile } from '../utils/env.js'
import { globalConfigPath } from '../utils/global-config.js'
import { writeGlobalCreds } from '../utils/global-config-writer.js'

class InitAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// #565: VALID_SOURCES / DEFAULT_SOURCE come from the task-source registry so the
// init flag/prompt path and the runtime resolver share one source of truth.

export async function initCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  fs: fsImpl,
  resetPrompt = false,
  agent: agentFlag = null,
  source: sourceFlag = null,
  isTTY = Boolean(process.stdin && process.stdin.isTTY),
  promptAgent = defaultPromptAgent,
  promptSource = defaultPromptSource,
  ask = confirm,
  promptValue = defaultPromptValue,
  home = homedir(),
  processEnv = process.env,
} = {}) {
  const fs = wrapFs(fsImpl)
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  // #560: an explicit --agent flag is validated EARLY and REJECTED hard on a
  // typo (before any file writes), so we never silently write claude when the
  // user clearly meant a specific agent. The non-flag paths (interactive prompt
  // and the "claude" default) still fall back gracefully via resolveAgent so an
  // unattended overnight run is never aborted by a stray keystroke at the prompt.
  //
  // #108: the echo goes through `oneLineEcho` for the same reason resolveAgent's does — a
  // value carrying a newline made this ONE write emit TWO lines of stderr, the second one an
  // `❌`/`✅` composed by nobody. It is still ECHOED (a typo the user cannot see is a typo
  // they cannot fix), just with the characters that end a line or drive a terminal replaced
  // one for one. The InitAbort message keeps the RAW value deliberately: nothing prints it
  // (bin/ralph.js reads only the exit code), and a programmatic caller catching it wants the
  // value as given, not our rendering of it. The guarantee belongs to what reaches a terminal.
  if (agentFlag != null && String(agentFlag).trim() !== '') {
    const normalized = String(agentFlag).trim().toLowerCase()
    if (!VALID_AGENTS.includes(normalized)) {
      err(
        `❌ Unknown agent '${oneLineEcho(agentFlag)}'. Valid agents: ${VALID_AGENTS.join(', ')}.`,
      )
      throw new InitAbort(`unknown agent '${agentFlag}'`, 1)
    }
  }

  // #565: an explicit --source flag is validated EARLY and REJECTED hard on a
  // typo (before any file writes), mirroring the --agent guard above. Empty/
  // whitespace is not a typo — it falls through to the interactive prompt or
  // the github default.
  if (sourceFlag != null && String(sourceFlag).trim() !== '') {
    const normalized = String(sourceFlag).trim().toLowerCase()
    if (!VALID_SOURCES.includes(normalized)) {
      // Sanitised like the agent echo above (#108) — leaving one of a matched pair raw is how
      // the next reader learns that the rule is optional.
      err(
        `❌ Unknown task source '${oneLineEcho(sourceFlag)}'. Valid sources: ${VALID_SOURCES.join(', ')}.`,
      )
      throw new InitAbort(`unknown task source '${sourceFlag}'`, 1)
    }
  }

  // #16: git-repo precondition. `ralph init` must be run inside a git work tree
  // — validated EARLY and REJECTED hard (like the --agent/--source typo guards
  // above) BEFORE any interactive prompt or file write. Without this, a failed
  // `git rev-parse` in resolveProjectRoot silently falls back to cwd and init
  // scaffolds files into a non-repo. The flag-typo guards run first (they touch
  // no exec); this is the first guard that actually shells out.
  const insideWorkTree = await exec(
    'git',
    ['rev-parse', '--is-inside-work-tree'],
    { cwd, reject: false },
  )
  if (insideWorkTree.exitCode !== 0) {
    err(
      "❌ ralph init must be run inside a git repository. Run 'git init' first (or cd into your repo).",
    )
    throw new InitAbort('not inside a git repository', 1)
  }

  // #554: pick the coding agent. Priority: explicit --agent flag > interactive
  // prompt (only when a TTY and no flag) > "claude" default. Whatever we land
  // on runs through the registry so a typo at the prompt falls back to claude.
  let agentChoice = agentFlag
  if (!agentChoice && isTTY) {
    agentChoice = await promptAgent({ stdout, ask })
  }
  const { agent, warning } = resolveAgent({ RALPH_AGENT: agentChoice ?? 'claude' })
  if (warning) err(`⚠️  ${warning}`)

  // #565: resolve the task source. Priority: explicit --source flag > interactive
  // prompt (only when a TTY and no flag) > "github" default. The flag was already
  // validated above; a prompt/env value is normalized and falls back to github.
  const source = await resolveSourceChoice({
    sourceFlag,
    isTTY,
    promptSource,
    stdout,
    promptValue,
  })

  // #133: and, when that source is jira, the two knobs a jira run cannot work
  // without. Asked here — beside the source, before any file is written — so every
  // question this command has is over before it starts scaffolding.
  const { jiraJql, jiraDoneStatus } = await resolveJiraSettings({
    source,
    isTTY,
    stdout,
    promptValue,
  })

  const projectRoot = await resolveProjectRoot({ cwd, exec })
  const stackInfo = detectStack(projectRoot, fsImpl)

  if (stackInfo.stack === 'unknown') {
    out(
      '⚠️  No supported manifest detected — INSTALL_CMD/TEST_CMD/LINT_CMD will be empty.',
    )
    out('   Edit ralph.config.sh after init or let Claude infer at runtime.')
  }

  const mainBranch = await detectMainBranch({ cwd: projectRoot, exec })
  const devBranch = await detectDevBranch({ cwd: projectRoot, exec, mainBranch })
  const prTarget = devBranch

  writeConfig({
    fs,
    out,
    // The shared interpolate warns about a `{{NAME}}` it has no value for and leaves it
    // in the file, and it defaults that warning to process.stderr; this command has its
    // own injected stderr, so it passes it. NOT reachable today and measured as such:
    // every placeholder in templates/ralph.config.sh is a key `vars` supplies, so
    // dropping this argument fails nothing in the suite. It is here for the next
    // placeholder somebody adds to the template without adding the key, and it is pinned
    // structurally (a source grep in lib/init.qa.test.js) precisely because no
    // behavioural test can reach it.
    stderr,
    path: join(projectRoot, 'ralph.config.sh'),
    vars: {
      INSTALL_CMD: stackInfo.install,
      TEST_CMD: stackInfo.test,
      LINT_CMD: stackInfo.lint,
      MAIN_BRANCH: mainBranch,
      DEV_BRANCH: devBranch,
      PR_TARGET: prTarget,
      RALPH_AGENT: agent,
      TASK_SOURCE: source,
      // #133: PRE-QUOTED, unlike every other var here, because which quote character
      // is correct depends on the value — see quoteConfigValue. The template's
      // placeholders for these two carry no quotes of their own.
      JIRA_JQL: quoteConfigValue(jiraJql),
      JIRA_DONE_STATUS: quoteConfigValue(jiraDoneStatus),
    },
  })

  // #565: in folder mode, scaffold the empty task tree so the loop has
  // somewhere to read from on first run. github mode never creates it.
  if (source === 'folder') {
    scaffoldTaskTree({ fs, out, projectRoot })
  }

  writeIfAbsent({
    fs,
    out,
    path: join(projectRoot, 'PROMPT.md'),
    body: readTemplate('PROMPT.md'),
    label: 'PROMPT.md',
    force: resetPrompt,
    resetHint: '--reset-prompt',
  })

  writeAlways({
    fs,
    out,
    path: join(projectRoot, '.env.local.example'),
    body: readTemplate('env.local.example'),
    label: '.env.local.example',
  })

  writeAlways({
    fs,
    out,
    path: join(projectRoot, 'ralph-notify.sh.example'),
    body: readTemplate('ralph-notify.sh.example'),
    label: 'ralph-notify.sh.example',
  })

  writeSlashCommand({ fs, out, projectRoot })

  appendGitignore({
    fs,
    out,
    path: join(projectRoot, '.gitignore'),
    lines: ['.ralph/', 'ralph-notify.sh', '.env.local'],
  })

  // #5: interactive global WhatsApp setup runs AFTER file scaffolding and only
  // when a TTY is present (a non-TTY/overnight run skips it silently). Writes to
  // ~/.config/ralph/.env (honoring XDG) so creds are shared across repos.
  await setupWhatsApp({
    isTTY,
    fs,
    out,
    ask,
    promptValue,
    stdout,
    home,
    processEnv,
  })

  printSummary({
    out,
    stackInfo,
    mainBranch,
    devBranch,
    prTarget,
    source,
    jiraJql,
    globalPath: globalConfigPath({ processEnv, home }),
  })

  return {
    exitCode: 0,
    projectRoot,
    stack: stackInfo.stack,
    install: stackInfo.install,
    test: stackInfo.test,
    lint: stackInfo.lint,
    mainBranch,
    devBranch,
    prTarget,
    agent,
    source,
    // #133: the RESOLVED Jira knobs — '' for github and folder, a working pair for
    // jira. Returned beside `source` for the same reason it is: a programmatic caller
    // (and the test suite) can then assert what was decided without re-parsing the
    // file, and the two values are the only part of this decision the file spells
    // differently than it was decided (they are quoted on the way in).
    jiraJql,
    jiraDoneStatus,
  }
}

// Resolve TASK_SOURCE. Priority: explicit --source flag > interactive prompt
// (only when a TTY and no flag) > "github" default. Any resolved value is
// normalized and falls back to github when unrecognized (a prompt typo never
// aborts an unattended run).
async function resolveSourceChoice({ sourceFlag, isTTY, promptSource, stdout, promptValue }) {
  let choice = sourceFlag
  if ((choice == null || String(choice).trim() === '') && isTTY) {
    choice = await promptSource({ stdout, promptValue })
  }
  const normalized = String(choice ?? '').trim().toLowerCase()
  return VALID_SOURCES.includes(normalized) ? normalized : DEFAULT_SOURCE
}

// #133: interactive source picker — a THREE-WAY choice, over `promptValue` rather
// than `confirm`. It was a yes/no ("...a local .ralph/tasks/ folder instead of
// GitHub? [y/N]") from #565 until #125 added a third source, and a boolean has no
// answer that means jira: the only way to reach it was the flag or hand-editing
// ralph.config.sh, which is not a first run anybody has.
//
// The answer is deliberately NOT validated here. It goes back to
// resolveSourceChoice, which puts it through the same VALID_SOURCES normalization
// the flag's value gets, so a typo at the prompt lands on github instead of
// aborting an unattended run — the rule the agent picker follows too. The default
// is shown in the prompt because a blank answer takes it.
//
// `promptValue` is injectable so tests never touch real stdin.
async function defaultPromptSource({ stdout = process.stdout, promptValue = defaultPromptValue } = {}) {
  return promptValue('Draw tasks from github, folder or jira? [github]: ', {
    output: stdout,
  })
}

// #133: the JQL a jira init writes when the user just presses enter. Every work item
// assigned to the authenticated user that no workflow has finished — a query narrow
// enough to be safe on any board (every label Ralph writes is a write to somebody's
// Jira) and broad enough to have a non-zero depth on a first run. Ralph appends its
// own label exclusion and ordering to whatever this says, so it deliberately
// mentions neither; see templates/ralph.config.sh for whose half is whose.
const DEFAULT_JIRA_JQL =
  'assignee = currentUser() AND status NOT IN ("Done", "Closed", "Resolved", "Canceled")'

// #133: the completion status a jira init writes when the user just presses enter.
// Status names come from each project's own workflow, which is why the TEMPLATE ships no
// default of its own — but a value chosen at an interactive prompt is a choice the
// user made and can see, and a refused transition costs a board move and never the
// run (lib/jira-* warns and still labels the ticket `done`), so guessing here is cheap
// where guessing in a shipped default would not be.
const DEFAULT_JIRA_DONE_STATUS = 'Done'

// #133: resolve the two Jira knobs.
//
// Only a jira init fills them. github and folder get '' — byte-for-byte the empty
// assignments the template has always shipped — so nothing about either mode changes.
//
// On a TTY the user is asked, with each default shown in its own prompt, and a blank
// answer takes it. Without a TTY the defaults are written silently: a jira source with
// an EMPTY JQL is inert (lib/jira-queue.js runs no acli for an empty query, so the
// depth reads as 0 and a loop started with it exits "Queue empty" on its first pass),
// so `ralph init --source jira` in a script would otherwise produce a config that
// cannot run until somebody hand-edits it. Nothing here blocks and nothing here
// validates the query against Jira — that would need network and auth at init time,
// and a bad query already surfaces as a zero-depth queue on the first run.
async function resolveJiraSettings({ source, isTTY, stdout, promptValue }) {
  if (source !== 'jira') return { jiraJql: '', jiraDoneStatus: '' }
  if (!isTTY) {
    return { jiraJql: DEFAULT_JIRA_JQL, jiraDoneStatus: DEFAULT_JIRA_DONE_STATUS }
  }
  const jql = await promptValue(`Jira eligibility query (JQL) [${DEFAULT_JIRA_JQL}]: `, {
    output: stdout,
  })
  const doneStatus = await promptValue(
    `Jira status for a finished ticket [${DEFAULT_JIRA_DONE_STATUS}]: `,
    { output: stdout },
  )
  return {
    jiraJql: answerOrDefault(jql, DEFAULT_JIRA_JQL),
    jiraDoneStatus: answerOrDefault(doneStatus, DEFAULT_JIRA_DONE_STATUS),
  }
}

// #133: what a prompt answer means. Blank — including whitespace only — is "keep the
// default", which is the answer pressing enter gives. The trim is repeated here rather
// than left to `promptValue` (which trims) because the seam is injectable: the rule
// about what counts as a blank answer belongs to the caller that acts on it.
function answerOrDefault(answer, fallback) {
  const trimmed = String(answer ?? '').trim()
  return trimmed === '' ? fallback : trimmed
}

// #133: the characters bash reinterprets INSIDE a double-quoted word — `"` ends the
// word, `$` expands, a backtick substitutes, `\` escapes the next character.
const REINTERPRETED_IN_DOUBLE_QUOTES = /["$`\\]/

// #133: bash-quote a value for ralph.config.sh — the whole right-hand side of the
// assignment, quotes included, because WHICH quote character is correct is a property
// of the value.
//
// Every other knob in templates/ralph.config.sh hardcodes `VAR="{{PLACEHOLDER}}"`, and
// for JIRA_JQL that shape is broken, because the value carries double quotes of its own.
// Both failures below were MEASURED against a real bash, not reasoned about:
//
//   * The default query this command offers, written that way, LOSES ITS QUOTES SILENTLY.
//     `JIRA_JQL="assignee = ... NOT IN ("Done", "Closed", ...)"` sources with status 0 and
//     leaves the shell holding `... NOT IN (Done, Closed, Resolved, Canceled)` — the inner
//     quotes gone — while `parseConfigVar` reads the same line with them intact. Two
//     readers, two different queries, and no error from either.
//   * And a quoted literal with a SPACE in it truncates the assignment at that space:
//     `JIRA_JQL="summary ~ "Ready for Release""` leaves JIRA_JQL UNSET in the sourcing
//     shell and bash says `for: command not found` — the tail of the line ran as a
//     command. Unset means "not configured", so that loop exits "Queue empty" on its
//     first pass; `parseConfigVar` reads `summary ~ "Ready for Release"` off the same line.
//
// THE RULE: double quotes, unless the value holds one of the characters above — then
// single quotes, inside which bash reinterprets nothing at all, with any single quote
// in the value spliced out and back in the POSIX way (`'\''`, which closes the quoted
// run, escapes a literal quote, and reopens). Double quotes come FIRST only so that an
// ordinary value keeps the shape this file has always been read and hand-edited in.
// Measured against git history: every template version that carried these knobs shipped
// `JIRA_JQL=""` and `JIRA_DONE_STATUS=""`, so a github or folder init still emits the
// exact bytes the template used to ship, and a status name emits the shape the template's
// own commented example uses (`# JIRA_DONE_STATUS="Done"`, templates/ralph.config.sh:177)
// — `"Done"` has only ever appeared there as an example, never as a shipped assignment.
//
// THE FILE HAS TWO READERS AND BOTH WERE MEASURED, per row, in
// lib/init.qa.test.js — a real `bash` sourcing the line, and `parseConfigVar`, which is
// how `ralph cycle` and `ralph status` read JIRA_JQL without sourcing anything:
//
//   value                            emitted                              bash  parseConfigVar
//   (empty)                          JIRA_JQL=""                          ok    ok
//   project = RALPH                  JIRA_JQL="project = RALPH"           ok    ok
//   summary ~ '#123'                 JIRA_JQL="summary ~ '#123'"          ok    ok
//   project = R # note               JIRA_JQL="project = R # note"        ok    ok
//   ... NOT IN ("Done", "Closed")    JIRA_JQL='... NOT IN ("Done", ...)'  ok    ok
//   text ~ "$HOME `date`"            JIRA_JQL='text ~ "$HOME `date`"'     ok    ok
//   mixed "dq" and 'sq'              JIRA_JQL='mixed "dq" and '\''sq'\''' ok    READS THE SPLICE
//
// THE LAST ROW IS A LIMIT, NOT A GUARANTEE. A value holding a single quote AND one of
// the reinterpreted characters can only be written with the splice, and `parseConfigVar`
// closes a quoted value at the first matching quote — its own header says it has never
// modelled the adjacent-word concatenation the splice relies on. So bash gets that query
// right and the JS reader that counts the queue does not. Nothing here narrows it: the
// fix belongs in that parser, which every knob in this file is read through, and the
// shape is unreachable from the default this command offers. It is pinned as behaviour
// in lib/init.qa.test.js rather than claimed away here.
function quoteConfigValue(value) {
  const s = String(value ?? '')
  if (!REINTERPRETED_IN_DOUBLE_QUOTES.test(s)) return `"${s}"`
  return `'${s.split("'").join("'\\''")}'`
}

// #565: scaffold the empty folder-mode task tree. Only the afk lane has the four
// status dirs the loop moves tasks through; the hitl lane is human-only (todo).
function scaffoldTaskTree({ fs, out, projectRoot }) {
  const base = join(projectRoot, '.ralph', 'tasks')
  const dirs = [
    join(base, 'afk', 'todo'),
    join(base, 'afk', 'in-progress'),
    join(base, 'afk', 'done'),
    join(base, 'afk', 'failed'),
    join(base, 'hitl', 'todo'),
  ]
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
  out('✅ Scaffolded .ralph/tasks/ (afk + hitl lanes)')
}

// Interactive agent picker. Built on the shared `confirm` helper (#560) rather
// than a bespoke readline: a yes/no keeps the default (claude) as the safe path
// for a blank answer. `ask` is injectable so tests never touch real stdin.
async function defaultPromptAgent({ stdout = process.stdout, ask = confirm } = {}) {
  const useCodex = await ask('Use Codex instead of Claude Code? [y/N]: ', {
    output: stdout,
  })
  return useCodex ? 'codex' : 'claude'
}

// #5: mask a secret for display — keep the last 4 chars visible, replace the
// rest with `•`. Short secrets (<= 4 chars) are fully masked so nothing leaks.
function maskSecret(value) {
  const s = String(value ?? '')
  if (s.length <= 4) return '•'.repeat(s.length)
  return '•'.repeat(s.length - 4) + s.slice(-4)
}

// #5: interactive global WhatsApp credential setup. Reads the existing global
// config (~/.config/ralph/.env, honoring XDG via globalConfigPath) and:
//   - unset  → yes/no gate, then captures phone + key and writes them.
//   - already set → shows the phone in full and the key masked, then on "change
//     it? [y/N]" captures new values where a BLANK entry keeps the existing one.
// Skips entirely (no prompts, no writes) when there is no TTY. All prompts + fs
// + home/processEnv are injected so tests never touch real stdin or ~/.config.
async function setupWhatsApp({ isTTY, fs, out, ask, promptValue, stdout, home, processEnv }) {
  if (!isTTY) return

  const path = globalConfigPath({ processEnv, home })
  let content = ''
  try {
    content = fs.readFileSync(path, 'utf8').toString()
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const env = parseEnvFile(content)
  const hasCreds = Boolean(env.CALLMEBOT_KEY || env.WHATSAPP_PHONE)

  if (!hasCreds) {
    const wants = await ask('Set up WhatsApp notifications globally? [y/N]: ', {
      output: stdout,
    })
    if (!wants) {
      out('ℹ️  Skipping WhatsApp setup — notifications stay off.')
      return
    }
    const phone = await promptValue('WhatsApp phone (with country code, e.g. +15551234567): ', {
      output: stdout,
    })
    const key = await promptValue('CallMeBot API key: ', { output: stdout })
    writeGlobalCreds({
      values: { WHATSAPP_PHONE: phone, CALLMEBOT_KEY: key },
      fs,
      path,
    })
    out(`✅ Saved WhatsApp credentials to ${path}`)
    return
  }

  out('WhatsApp notifications are already configured globally:')
  out(`  WHATSAPP_PHONE: ${env.WHATSAPP_PHONE ?? '(unset)'}`)
  out(`  CALLMEBOT_KEY:  ${env.CALLMEBOT_KEY ? maskSecret(env.CALLMEBOT_KEY) : '(unset)'}`)
  const change = await ask('Change it? [y/N]: ', { output: stdout })
  if (!change) return

  const phone = await promptValue(
    'WhatsApp phone (blank keeps existing): ',
    { output: stdout },
  )
  const key = await promptValue('CallMeBot API key (blank keeps existing): ', {
    output: stdout,
  })
  const values = {}
  if (phone) values.WHATSAPP_PHONE = phone
  if (key) values.CALLMEBOT_KEY = key
  if (Object.keys(values).length === 0) {
    out('ℹ️  No changes — existing WhatsApp credentials kept.')
    return
  }
  writeGlobalCreds({ values, fs, path })
  out(`✅ Updated WhatsApp credentials in ${path}`)
}

function wrapFs(fsImpl) {
  if (!fsImpl) {
    return {
      existsSync: realExistsSync,
      readFileSync: realReadFileSync,
      writeFileSync: realWriteFileSync,
      mkdirSync: realMkdirSync,
      chmodSync: realChmodSync,
    }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    chmodSync: fsImpl.chmodSync ? fsImpl.chmodSync.bind(fsImpl) : undefined,
  }
}

async function resolveProjectRoot({ cwd, exec }) {
  const r = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false })
  if (r.exitCode === 0 && (r.stdout || '').trim()) {
    return r.stdout.trim()
  }
  return cwd
}

async function detectMainBranch({ cwd, exec }) {
  const r = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd,
    reject: false,
  })
  if (r.exitCode === 0) {
    const m = (r.stdout || '').trim().match(/^refs\/remotes\/origin\/(.+)$/)
    if (m) return m[1]
  }
  return 'main'
}

async function detectDevBranch({ cwd, exec, mainBranch }) {
  const r = await exec('git', ['branch', '-a'], { cwd, reject: false })
  const lines = (r.stdout || '')
    .split('\n')
    .map((s) => s.trim().replace(/^\*\s+/, ''))
  if (lines.includes('remotes/origin/dev')) return 'dev'
  if (lines.includes('remotes/origin/develop')) return 'develop'
  return mainBranch
}

function readTemplate(name) {
  return realReadFileSync(templatePath(name), 'utf8')
}

function writeConfig({ fs, out, stderr, path, vars }) {
  if (fs.existsSync(path)) {
    out('ℹ️  ralph.config.sh already exists — keeping your edits.')
    return
  }
  const body = interpolate(readTemplate('ralph.config.sh'), vars, { stderr })
  fs.writeFileSync(path, body)
  out('✅ Wrote ralph.config.sh')
}

function writeIfAbsent({ fs, out, path, body, label, force = false, resetHint }) {
  const exists = fs.existsSync(path)
  if (exists && !force) {
    const hint = resetHint ? ` (pass ${resetHint} to overwrite)` : ''
    out(`ℹ️  ${label} already exists — leaving it alone${hint}.`)
    return
  }
  fs.writeFileSync(path, body)
  if (exists && force) {
    out(`✅ Reset ${label} to package template`)
  } else {
    out(`✅ Wrote ${label}`)
  }
}

function writeAlways({ fs, out, path, body, label }) {
  fs.writeFileSync(path, body)
  out(`✅ Wrote ${label}`)
}

function writeSlashCommand({ fs, out, projectRoot }) {
  const dir = join(projectRoot, '.claude', 'commands')
  const path = join(dir, 'ralph.md')
  if (fs.existsSync(path)) {
    out(
      '⚠️  .claude/commands/ralph.md already exists — skipping. Run `ralph upgrade` once available to refresh.',
    )
    return
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path, readTemplate('slash-command.md'))
  out('✅ Wrote .claude/commands/ralph.md')
}

function appendGitignore({ fs, out, path, lines }) {
  let current = ''
  if (fs.existsSync(path)) {
    current = fs.readFileSync(path, 'utf8').toString()
  }
  const existing = new Set(current.split('\n').map((l) => l.trim()))
  const missing = lines.filter((l) => !existing.has(l))
  if (missing.length === 0) {
    out('ℹ️  .gitignore already has Ralph entries.')
    return
  }
  let next = current
  if (next.length > 0 && !next.endsWith('\n')) next += '\n'
  if (!current.includes('# Ralph')) {
    if (next.length > 0 && !next.endsWith('\n\n')) next += '\n'
    next += '# Ralph\n'
  }
  next += missing.join('\n') + '\n'
  fs.writeFileSync(path, next)
  out('✅ Updated .gitignore')
}

function printSummary({
  out,
  stackInfo,
  mainBranch,
  devBranch,
  prTarget,
  source,
  jiraJql,
  globalPath,
}) {
  const empty = (v) => (v ? v : '(empty)')
  out('')
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  out('Detected:')
  out(`  Stack:        ${stackInfo.stack}`)
  out(`  INSTALL_CMD:  ${empty(stackInfo.install)}`)
  out(`  TEST_CMD:     ${empty(stackInfo.test)}`)
  out(`  LINT_CMD:     ${empty(stackInfo.lint)}`)
  out(`  MAIN_BRANCH:  ${mainBranch}`)
  out(`  DEV_BRANCH:   ${devBranch}`)
  out(`  PR_TARGET:    ${prTarget}`)
  out(`  TASK_SOURCE:  ${source}`)
  // #133: the query a jira run will actually count and select with — echoed because
  // init just WROTE it, from a default the user may have accepted without reading, and
  // it is the one setting whose mistakes are silent (a query Jira rejects reads as a
  // queue of depth 0, so a cycle says "empty" rather than failing). No row at all for
  // the other two sources: there is no query for them to be shown.
  //
  // THROUGH `oneLineEcho`, like this command's two `❌ Unknown <thing>` echoes and for
  // #108's reason: this is a value the user just supplied at a prompt on this same run,
  // and it is one row of a box. Measured before the guard, a JQL carrying a newline made
  // this ONE write emit TWO lines and the second read as a summary row nobody composed
  // (`  FAKE_ROW:     pwned`), and an ESC reached the terminal verbatim.
  //
  // THE OTHER UNSANITISED ECHO IN THIS COMMAND — the stored WhatsApp phone above — is
  // left raw because it is PRE-EXISTING and outside #133, not because it is safe. An
  // earlier version of this comment claimed `parseEnvFile` made it mechanically
  // incapable of forging a row; that claim was false and is corrected here. Measured:
  // `parseEnvFile` splits on LF only and `trim()` strips a CR only at the ends, so with
  // `WHATSAPP_PHONE=+15551234567<CR>  CALLMEBOT_KEY:  totally-legit` in the global creds
  // file this command emits, in one write,
  //   "  WHATSAPP_PHONE: +15551234567\r  CALLMEBOT_KEY:  totally-legit"
  // which a terminal renders as the second row alone, overwriting the real one. NEL
  // (U+0085), U+2028, U+2029 and ESC survive that parse too — only LF cannot. So it is
  // the same class as this row, and a separate fix.
  //
  // The FILE gets the raw value; only the echo is scrubbed, because a query with a
  // U+FFFD substituted into it would be a different query than the one asked for.
  //
  // `empty()` here is uniformity with the rows above, not a live branch: `jiraJql` reaches
  // this row only when source is jira, and `answerOrDefault` substitutes the default for a
  // blank answer, so it cannot be '' — the `(empty)` text is unreachable today.
  if (source === 'jira') out(`  JIRA_JQL:     ${empty(oneLineEcho(jiraJql))}`)
  out('')
  out('WhatsApp notifications (optional):')
  out('  Ralph reads WhatsApp credentials from your global config (shared across repos):')
  out(`    ${globalPath}`)
  out(
    '  Set up CallMeBot: https://www.callmebot.com/blog/free-api-whatsapp-messages/',
  )
  out('  Keys: CALLMEBOT_KEY and WHATSAPP_PHONE (phone with country code).')
  out('  Re-run `ralph init` in a terminal to configure them interactively.')
  out('  For a per-repo override, set them in .env.local (see .env.local.example).')
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

export { InitAbort }
