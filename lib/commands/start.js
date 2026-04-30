import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execa } from 'execa'
import pc from 'picocolors'
import { loadEnvFile } from '../utils/env.js'
import { commandExists } from '../utils/which.js'
import { confirm } from '../utils/prompt.js'
import { templatePath } from '../paths.js'
import { assertCriticalDeps } from './doctor.js'
import { checkDeps } from '../deps.js'
import { detectPlatform } from '../platform.js'
import { readState, writeState } from '../state.js'
import { checkForUpdate } from '../update-check.js'
import { sendWhatsappMessage } from '../utils/whatsapp.js'
import { peekLock as defaultPeekLock } from '../lock.js'

const TMUX_SESSION = 'ralph'
const SEARCH_QUERY =
  'state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'
const DEFAULT_STARTUP_MESSAGE = '🟢 Ralph started and is active.'

class StartAbort extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function startCommand({
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  exec = execa,
  exists = existsSync,
  loadEnv = loadEnvFile,
  hasCommand = commandExists,
  ask = confirm,
  currentVersion = 'unknown',
  update = checkForUpdate,
  readSt = readState,
  writeSt = writeState,
  sendWa = sendWhatsappMessage,
  peekLock = defaultPeekLock,
  now = Date.now,
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  // 1. tmux session uniqueness (best-effort: silently fall through if tmux missing,
  //    the dep check below will catch and report it).
  if (hasCommand('tmux')) {
    const has = await exec('tmux', ['has-session', '-t', TMUX_SESSION], { reject: false })
    if (has.exitCode === 0) {
      err(`❌ Sessão tmux '${TMUX_SESSION}' já existe.`)
      out(`   Ver:    tmux attach -t ${TMUX_SESSION}`)
      out(`   Matar:  tmux kill-session -t ${TMUX_SESSION}`)
      throw new StartAbort('tmux session already exists', 1)
    }
  }

  // 1.5. ralph cycle coexistence — abort if a live cycle holds the lock.
  // Stale lock holders fall through silently so a crashed cycle doesn't block start.
  const lockState = peekLock(cwd)
  if (lockState && lockState.alive) {
    const ageH = ageInHours(now(), lockState.holder?.startedAt)
    err(
      `⏸️ Cycle in progress (PID ${lockState.holder?.pid} for ${ageH}h) — wait or run \`ralph schedule pause\` first`,
    )
    throw new StartAbort('cycle lock held', 1)
  }

  // 2. Required commands (shared dep check)
  const platform = detectPlatform()
  const depCheck = assertCriticalDeps({ hasCommand, platform })
  if (!depCheck.ok) {
    err(depCheck.message)
    throw new StartAbort(
      `missing command: ${depCheck.missingCritical.map((d) => d.name).join(', ')}`,
      1,
    )
  }
  const missingNonCritical = checkDeps({ hasCommand }).filter(
    (r) => !r.present && !r.critical,
  )
  for (const r of missingNonCritical) {
    out(`⚠️  '${r.name}' não encontrado (opcional). Algumas funções podem falhar.`)
  }

  // 3. .env.local — informational only
  const envPath = resolve(cwd, '.env.local')
  let env = {}
  if (exists(envPath)) {
    env = loadEnv(envPath)
  }
  const callmebotKey = env.CALLMEBOT_KEY ?? process.env.CALLMEBOT_KEY ?? ''
  const whatsappPhone = env.WHATSAPP_PHONE ?? process.env.WHATSAPP_PHONE ?? ''
  const startupMessage =
    env.RALPH_STARTUP_MESSAGE ??
    process.env.RALPH_STARTUP_MESSAGE ??
    DEFAULT_STARTUP_MESSAGE
  if (!callmebotKey || !whatsappPhone) {
    out('ℹ️  CALLMEBOT_KEY/WHATSAPP_PHONE ausentes; notificações WhatsApp serão puladas.')
  }

  // 4. gh authenticated
  const ghAuth = await exec('gh', ['auth', 'status'], { reject: false })
  if (ghAuth.exitCode !== 0) {
    err("❌ gh não autenticado. Rode 'gh auth login'.")
    throw new StartAbort('gh not authenticated', 1)
  }

  // 5. .mcp.json validity
  const mcpPath = resolve(cwd, '.mcp.json')
  if (exists(mcpPath)) {
    const mcpCheck = await exec('jq', ['-e', '.', mcpPath], { reject: false })
    if (mcpCheck.exitCode !== 0) {
      err('❌ .mcp.json com JSON inválido')
      throw new StartAbort('invalid .mcp.json', 1)
    }
    const serversResult = await exec(
      'jq',
      ['-r', '.mcpServers | keys | join(", ")', mcpPath],
      { reject: false },
    )
    const servers = (serversResult.stdout || '').trim()
    out(`ℹ️  MCP servers configurados: ${servers}`)
    out(
      "   Se a auth de algum MCP expirou, rode 'claude' interativamente uma vez antes pra re-autenticar.",
    )
  }

  // 6. Create labels (idempotent)
  await exec(
    'gh',
    [
      'label',
      'create',
      'claude-working',
      '--color',
      'FFA500',
      '--description',
      'Ralph loop em andamento',
    ],
    { reject: false },
  )
  await exec(
    'gh',
    [
      'label',
      'create',
      'claude-failed',
      '--color',
      'B60205',
      '--description',
      'Ralph loop tentou e desistiu',
    ],
    { reject: false },
  )
  await exec(
    'gh',
    [
      'label',
      'create',
      'pending-merge',
      '--color',
      '0E8A16',
      '--description',
      'Ralph PR merged into staging branch, awaiting rollforward to default',
    ],
    { reject: false },
  )

  // 7. Orphan claude-working cleanup
  const orphanList = await exec(
    'gh',
    [
      'issue',
      'list',
      '--state',
      'open',
      '--label',
      'claude-working',
      '--json',
      'number,title',
      '-q',
      '.[] | "  #\\(.number) \\(.title)"',
    ],
    { reject: false },
  )
  const orphaned = (orphanList.stdout || '').trim()
  if (orphaned) {
    out("⚠️  Issues com label 'claude-working' (run anterior interrompido):")
    out(orphaned)
    out('ℹ️  Mantendo labels. Essas issues serão puladas neste run.')
    out('   Para reprocessar, remova manualmente: gh issue edit <n> --remove-label claude-working')
  }

  // 8. Queue check
  const queue = await exec(
    'gh',
    [
      'issue',
      'list',
      '--search',
      SEARCH_QUERY,
      '--limit',
      '100',
      '--json',
      'number',
      '-q',
      '. | length',
    ],
    { reject: false },
  )
  const count = (queue.stdout || '').trim()
  if (count === '0') {
    out('ℹ️  Nenhuma issue na fila. Nada a fazer.')
    return { exitCode: 0, started: false }
  }

  // 8.5. Update check (best-effort, silent on failure)
  const state = readSt(cwd)
  if (state) {
    const { newVersion, updatedState } = await update(currentVersion, state, { exec })
    if (newVersion) {
      out(
        pc.yellow(
          `New version available: ${newVersion} (run npm i -g @lucasfe/ralph to update)`,
        ),
      )
      writeSt(cwd, updatedState)
    }
  }

  // 9. Launch tmux detached, running the bash loop shipped with the package
  const ralphTemplate = templatePath('ralph.sh')
  const tmuxLaunch = await exec(
    'tmux',
    ['new', '-d', '-s', TMUX_SESSION, `cd '${cwd}' && bash '${ralphTemplate}'`],
    { reject: false },
  )
  if (tmuxLaunch.exitCode !== 0) {
    err(`❌ Falha ao iniciar sessão tmux: ${(tmuxLaunch.stderr || '').trim()}`)
    throw new StartAbort('tmux launch failed', 1)
  }

  out(`✅ Ralph iniciado em background. ${count} issues na fila.`)
  out(`   Ver ao vivo:    tmux attach -t ${TMUX_SESSION}`)
  out('   Detach:         dentro da sessão, Ctrl+B depois D')
  out('   Listar:         tmux ls')
  out(`   Matar:          tmux kill-session -t ${TMUX_SESSION}`)
  out('   Logs:           logs/ralph-issue-*.log')

  // Startup notification — best effort, never blocks startup or surfaces stack traces.
  if (callmebotKey && whatsappPhone) {
    const waResult = await sendWa({
      phone: whatsappPhone,
      apiKey: callmebotKey,
      message: startupMessage,
    })
    if (waResult?.ok) {
      out('📲 Notificação WhatsApp de startup enviada.')
    } else {
      out(`⚠️  Notificação WhatsApp de startup falhou: ${waResult?.reason ?? 'unknown'}.`)
    }
  }

  return { exitCode: 0, started: true, count: Number(count) }
}

function ageInHours(nowMs, isoStartedAt) {
  if (!isoStartedAt) return 0
  const startMs = Date.parse(isoStartedAt)
  if (!Number.isFinite(startMs)) return 0
  return Math.max(0, Math.round((nowMs - startMs) / 3600000))
}

export { StartAbort }
