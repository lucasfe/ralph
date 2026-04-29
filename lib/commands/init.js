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

class InitAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function initCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exec = execa,
  fs: fsImpl,
  resetPrompt = false,
} = {}) {
  const fs = wrapFs(fsImpl)
  const out = (m) => stdout.write(m + '\n')

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
    },
  })

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

  printSummary({ out, stackInfo, mainBranch, devBranch, prTarget })

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
  }
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

function printSummary({ out, stackInfo, mainBranch, devBranch, prTarget }) {
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
