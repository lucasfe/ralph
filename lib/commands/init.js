import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  writeFileSync as realWriteFileSync,
  mkdirSync as realMkdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { detectStack } from '../detect-stack.js'
import { templatePath } from '../paths.js'
import { resolveAgent, VALID_AGENTS } from '../agent-registry.js'
import { VALID_SOURCES, DEFAULT_SOURCE } from '../task-source.js'
import { confirm } from '../utils/prompt.js'

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
} = {}) {
  const fs = wrapFs(fsImpl)
  const out = (m) => stdout.write(m + '\n')
  const err = (m) => stderr.write(m + '\n')

  // #560: an explicit --agent flag is validated EARLY and REJECTED hard on a
  // typo (before any file writes), so we never silently write claude when the
  // user clearly meant a specific agent. The non-flag paths (interactive prompt
  // and the "claude" default) still fall back gracefully via resolveAgent so an
  // unattended overnight run is never aborted by a stray keystroke at the prompt.
  if (agentFlag != null && String(agentFlag).trim() !== '') {
    const normalized = String(agentFlag).trim().toLowerCase()
    if (!VALID_AGENTS.includes(normalized)) {
      err(
        `❌ Unknown agent '${agentFlag}'. Valid agents: ${VALID_AGENTS.join(', ')}.`,
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
      err(
        `❌ Unknown task source '${sourceFlag}'. Valid sources: ${VALID_SOURCES.join(', ')}.`,
      )
      throw new InitAbort(`unknown task source '${sourceFlag}'`, 1)
    }
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
    ask,
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

  printSummary({ out, stackInfo, mainBranch, devBranch, prTarget, source })

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
  }
}

// Resolve TASK_SOURCE. Priority: explicit --source flag > interactive prompt
// (only when a TTY and no flag) > "github" default. Any resolved value is
// normalized and falls back to github when unrecognized (a prompt typo never
// aborts an unattended run).
async function resolveSourceChoice({ sourceFlag, isTTY, promptSource, stdout, ask }) {
  let choice = sourceFlag
  if ((choice == null || String(choice).trim() === '') && isTTY) {
    choice = await promptSource({ stdout, ask })
  }
  const normalized = String(choice ?? '').trim().toLowerCase()
  return VALID_SOURCES.includes(normalized) ? normalized : DEFAULT_SOURCE
}

// Interactive source picker. Built on the shared `confirm` helper (matching the
// agent picker): a yes/no keeps the default (github) as the safe path for a
// blank answer. `ask` is injectable so tests never touch real stdin.
async function defaultPromptSource({ stdout = process.stdout, ask = confirm } = {}) {
  const useFolder = await ask('Draw tasks from a local .ralph/tasks/ folder instead of GitHub? [y/N]: ', {
    output: stdout,
  })
  return useFolder ? 'folder' : 'github'
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

function wrapFs(fsImpl) {
  if (!fsImpl) {
    return {
      existsSync: realExistsSync,
      readFileSync: realReadFileSync,
      writeFileSync: realWriteFileSync,
      mkdirSync: realMkdirSync,
    }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
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

function interpolate(template, vars) {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value ?? '')
  }
  return result
}

function writeConfig({ fs, out, path, vars }) {
  if (fs.existsSync(path)) {
    out('ℹ️  ralph.config.sh already exists — keeping your edits.')
    return
  }
  const body = interpolate(readTemplate('ralph.config.sh'), vars)
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

function printSummary({ out, stackInfo, mainBranch, devBranch, prTarget, source }) {
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
  out('')
  out('WhatsApp notifications (optional):')
  out(
    '  1. Set up CallMeBot: https://www.callmebot.com/blog/free-api-whatsapp-messages/',
  )
  out('  2. Copy .env.local.example to .env.local and set:')
  out('       CALLMEBOT_KEY=<your-key>')
  out('       WHATSAPP_PHONE=<your-phone-with-country-code>')
  out('  3. .gitignore already excludes .env.local')
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

export { InitAbort }
