import { existsSync, readFileSync as realReadFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { execa } from 'execa'
import pc from 'picocolors'
import { loadEnvFile } from '../utils/env.js'
import { createCredentialResolver } from '../utils/global-config.js'
import { commandExists } from '../utils/which.js'
import { confirm } from '../utils/prompt.js'
import { defaultRalphBinary, templatePath } from '../paths.js'
import { assertCriticalDeps } from './doctor.js'
import { checkDeps } from '../deps.js'
import { detectPlatform } from '../platform.js'
import { isUpdateCheckDisabled, recordPromptShown, resolveUpdateDecision } from '../update-check.js'
import { runUpdateGate } from '../update-gate.js'
import { updateCommand } from './update.js'
import { sendWhatsappMessage } from '../utils/whatsapp.js'
import { peekLock as defaultPeekLock, sessionNameFor } from '../lock.js'
import { parseConfigSource, readConfigText } from '../read-config-source.js'
import { parseConfigVar } from '../parse-config-var.js'
import { parseTimerDuration } from '../duration.js'
// The same one-line-diagnostic rule `ralph digest` prints its own failures through
// (#62), imported rather than re-derived: it collapses whitespace AND caps the length,
// and a warning here is read in the same terminal as one from there.
import { oneLine } from '../digest.js'
// ...and the knob this command opens the digest's window with, read by the one rule
// `ralph digest --loop` waits on and `ralph status` measures staleness against (#63).
import { digestInterval } from '../digest-file.js'
import { resolveSource } from '../task-source.js'
import { queueCount as folderQueueCountLib } from '../folder-queue.js'
import { metricsPath, safeReadMetrics } from '../issue-metrics.js'
import { buildLaunchProjection, renderLaunchProjection } from '../progress.js'
// #67: the banner's gate and its one rendered frame. Both pure, both fed values this
// command already has injected — see the `stdoutIsTTY`/`color` options below.
import { colorEnabled, renderStaticBanner } from '../sprite-banner.js'
// #68: the banner's other half — the identity box, composed from resolved facts. Pure
// too, which is why the impure half of it (reading the cached version below) is this
// command's job rather than the module's.
import { composeBanner } from '../banner-compose.js'
import { readVersionCache } from '../version-cache.js'

const SEARCH_QUERY =
  'state:open -label:claude-working -label:claude-failed -label:do-not-ralph -label:pending-merge'
const DEFAULT_STARTUP_MESSAGE = '🟢 Ralph started and is active.'
// #62: the digest's window name. Named rather than addressed by index so teardown
// and inspection have a stable handle — see openDigestWindow below.
const DIGEST_WINDOW = 'digest'

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
  // #25: the update prompt is TTY-gated — a blocking readline on a launchd- or
  // CI-spawned process would hang forever, so a non-interactive run only ever
  // gets #24's printed notice. The default is derived from the RESOLVED `stdin`
  // above — the injected stream when there is one, the ambient `process.stdin`
  // otherwise via that parameter's own default — precisely so a caller that
  // injects a non-interactive stream cannot be handed a readline over it:
  // `confirm` never resolves on an input that ends without a line, so that would
  // be an unrecoverable hang. Legal because destructuring defaults evaluate left
  // to right and `stdin` is declared before this.
  isTTY = Boolean(stdin?.isTTY),
  exec = execa,
  exists = existsSync,
  loadEnv = loadEnvFile,
  hasCommand = commandExists,
  ask = confirm,
  currentVersion = 'unknown',
  update = resolveUpdateDecision,
  // #26: the prompt-window stamp. Injected on the same convention as `update` and
  // `cacheFs` below, so the CALL is observable and orderable in tests — several of
  // them spy on it to assert it runs before `await ask`. The write it performs is
  // asserted through `cacheFs`, not through here.
  recordPrompt = recordPromptShown,
  // #25: the `ralph update` machinery from #21, injected so tests never shell out.
  runUpdate = updateCommand,
  sendWa = sendWhatsappMessage,
  peekLock = defaultPeekLock,
  readFile = realReadFileSync,
  folderQueueCount = defaultFolderQueueCount,
  now = Date.now,
  home = homedir(),
  processEnv = process.env,
  // #67: the two capabilities the sprite banner needs. Deliberately NOT the `isTTY`
  // above — that one is about STDIN, and it gates a blocking readline; this one is
  // about STDOUT, and it gates escape sequences. A launchd run piping stdout to a
  // log can still be interactive on stdin and vice versa, so folding them together
  // would print a screenful of ANSI into a log file to decide whether to prompt.
  // Same left-to-right destructuring trick as `isTTY`: derived from the RESOLVED
  // `stdout` above, so injecting a stream is enough to control it, and overriding
  // the option explicitly still wins over whatever the stream claims.
  stdoutIsTTY = Boolean(stdout?.isTTY),
  // ...and the colour policy, resolved from the environment already injected above
  // rather than from `process.env`, so a test never depends on the shell it runs in
  // (#41). See lib/sprite-banner.js for why NO_COLOR is honored on presence.
  color = colorEnabled({ env: processEnv, isTTY: stdoutIsTTY }),
  // #68: the width the identity box is held to. Same left-to-right trick again, from
  // the RESOLVED `stdout`: a terminal reports its columns, a pipe reports `undefined`,
  // and composeBanner treats absent — or zero, which some CI runners report — as its
  // own 60-column default rather than as a one-column box.
  columns = stdout?.columns,
  // #24: fs impl for the global update-check cache — injected (memfs) in tests
  // so no run touches the real ~/.config/ralph.
  cacheFs,
  // #68: how the box learns there is a newer version. THE CACHE ONLY — this is the
  // banner, printed before the first preflight line, and it must not add a network
  // round trip to `ralph start`'s first paint. The registry check is #24's, it happens
  // at step 2.5 with its own weekly throttle, and it is what fills this cache; the box
  // reports what that last check left behind. Injected so no test in this repo reads a
  // real ~/.config/ralph and so a developer's own cached update cannot add a row to
  // another suite's expected output (#41).
  readCache = readVersionCache,
  // #62: the binary the digest window runs, resolved the way schedule.js resolves
  // the one it writes into a plist. Injectable so no test's expectations depend on
  // how the process was spawned.
  ralphBinary = defaultRalphBinary(),
} = {}) {
  const out = (msg) => stdout.write(msg + '\n')
  const err = (msg) => stderr.write(msg + '\n')

  // #67: the sprite, and the FIRST thing this command writes — above the tmux
  // uniqueness check, above the config read, above every preflight line. It is a
  // curtain going up, so it has to be there on the runs that fail too: a banner
  // printed after the guard would be missing from exactly the run where it is the
  // only thing above the error. Empty array on a pipe, a log, or NO_COLOR, so the
  // loop below writes nothing at all and every other line stays byte-identical.
  for (const line of renderStaticBanner({ isTTY: stdoutIsTTY, color })) out(line)

  // #68: ...and the identity box under it, which is the half a reader can USE — which
  // Ralph this is, where it is running, and whether a newer one is waiting.
  //
  // NOT gated on the terminal, and that is the deliberate part: the sprite above is
  // decoration and disappears on a pipe, but these are facts, and a launchd log or a CI
  // job is exactly where "which version, which directory" is the question being asked.
  // The PRD says a run without colour or without a TTY gets the facts alone, so that is
  // what it gets — in plain text, with not one escape byte, because `color` is passed
  // through and composeBanner only paints the update hint when it is true.
  //
  // Printed here, immediately under the sprite and above every other side effect, for
  // the same reason the sprite is: the aborting runs are the ones where this box is the
  // only context the error has.
  //
  // THE FACTS ARE RESOLVED HERE, and this is the seam later slices grow: #69's agent,
  // model, context window, task source and repo, and #70's what's-new bullets, are more
  // entries in this one object — read on this impure side, from the config text and the
  // cache, and handed to a module that still touches nothing. Note what that costs
  // #69: `source` and `digest` below are parsed AFTER this point, so a slice that wants
  // them in the box must move the config read above it, not the box below them.
  for (const line of composeBanner({
    facts: {
      version: currentVersion,
      latestVersion: cachedLatestVersion({ readCache, fs: cacheFs, processEnv, home }),
      cwd,
    },
    width: columns,
    capabilities: { color },
  })) {
    out(line)
  }

  // Per-project tmux session name so multiple repos can run Ralph concurrently
  // without colliding on a single literal 'ralph' session.
  const session = sessionNameFor(cwd)

  // #565: resolve the task source from ralph.config.sh so `ralph start` is
  // folder-aware like `ralph cycle`. Folder mode never touches gh (no auth
  // check, no labels, no orphan sweep) and counts the queue from the local
  // .ralph/tasks tree. The github path (default) is unchanged. Behaviour is
  // otherwise identical between sources — only where issues are picked up
  // differs; the loop (templates/ralph.sh) already dispatches both.
  //
  // ONE read of the file, two values out of it (#60): the source, and the digest
  // interval the hint block below needs. Reading it twice would let a config
  // rewritten mid-preflight answer the two questions differently, and the parse is
  // over text either way — see parse-config-var.js for the shared grammar.
  const configText = readConfigText(resolve(cwd, 'ralph.config.sh'), { exists, readFile })
  const source = resolveSource({
    TASK_SOURCE: parseConfigSource(configText) || processEnv.TASK_SOURCE,
  })
  const digest = digestInterval(configText)

  // 1. tmux session uniqueness (best-effort: silently fall through if tmux missing,
  //    the dep check below will catch and report it). Only THIS project's session
  //    blocks start — another project's session is unrelated.
  if (hasCommand('tmux')) {
    const has = await exec('tmux', ['has-session', '-t', session], { reject: false })
    if (has.exitCode === 0) {
      err(`❌ tmux session '${session}' already exists.`)
      out(`   Watch:  tmux attach -t ${session}`)
      out(`   Kill:   tmux kill-session -t ${session}`)
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
    out(`⚠️  '${r.name}' not found (optional). Some features may not work.`)
  }

  // 2.5. #24/#25/#26: the update notice, the TTY-gated prompt and the weekly
  // prompt window, as one policy in ../update-gate.js (#50) — which is also where
  // every "why" about it now lives. This site owns two things only: WHERE the gate
  // runs, and what an accepted install means for a launch.
  //
  // It sits HERE, and not where the old step-8.5 block did, for two reasons: 8.5
  // ran after the empty-queue early return, so a user with an empty queue never saw
  // the notice; and running before the gh label/orphan/queue calls means #25's
  // accept path won't discard work already done.
  //
  // What the placement buys, precisely: it is after the three guards that abort
  // LOCALLY — tmux session, cycle lock, missing dependency — none of which touch
  // the network or do work a user sees, so those aborts stay silent and spend
  // nothing. It does NOT mean no aborting run ever shows the notice: `gh auth
  // status` below, an invalid `.mcp.json`, and a failed tmux launch all abort
  // AFTER this point, and such a run both prints the notice and stamps
  // last_check_at, burning the weekly window. That is accepted: the notice is
  // advice, not a step, and the alternative — checking after every guard — puts
  // it back behind the empty-queue early return that step 8.5 was moved out of.
  //
  // The gate prints nothing but the notice, so a failed, throttled or opted-out
  // check is silent, and it guards every boundary it owns — so this call needs no
  // guard of its own. Not that nothing can escape it: a broken `ask` still aborts
  // the run with its raw error, pinned in start.update-prompt.qa.test.js and
  // deliberate, since a prompt that cannot be answered must not be read as consent.
  // Wrapping this call would swallow that too, which is why it is not wrapped.
  const updateGate = await runUpdateGate({
    currentVersion,
    exec,
    now,
    processEnv,
    home,
    cacheFs,
    stdout,
    stderr,
    stdin,
    isTTY,
    update,
    recordPrompt,
    runUpdate,
    ask,
  })
  if (updateGate.installed) {
    // #25: no re-exec and no background install, on purpose. THIS process
    // already holds pre-update module state, and `templatePath('ralph.sh')`
    // below resolves against the OLD install — the tmux loop reads that
    // template at launch. Exiting cleanly is the only way to guarantee the
    // loop never runs a half-swapped mixture of two versions.
    out(pc.green(`✅ Updated to ${updateGate.installedVersion} — run \`ralph start\` again.`))
    return { exitCode: 0, started: false }
  } else if (updateGate.accepted) {
    // Accepted but not updated — a failed install, or nothing to update here (an
    // npx run, a linked dev checkout). Either way the loop still launches on the
    // current version: an update is never worth losing a run over. runUpdate wrote
    // its own diagnostics, so this adds one neutral line and falls through.
    //
    // `else if`, not a second `if`: the two outcomes are mutually exclusive, and
    // saying so locally means a future caller with cleanup to do before returning —
    // releasing a lock, say — cannot turn a dropped `return` above into a run that
    // announces both a successful update and a failed one.
    out(`⚠️  Update did not complete — starting Ralph on ${currentVersion}.`)
  }

  // 3. .env.local — informational only
  const envPath = resolve(cwd, '.env.local')
  let env = {}
  if (exists(envPath)) {
    env = loadEnv(envPath)
  }
  const resolveCred = createCredentialResolver({ repoEnv: env, processEnv, home, loadEnv })
  const callmebotKey = resolveCred('CALLMEBOT_KEY') ?? ''
  const whatsappPhone = resolveCred('WHATSAPP_PHONE') ?? ''
  const startupMessage = resolveCred('RALPH_STARTUP_MESSAGE') ?? DEFAULT_STARTUP_MESSAGE
  if (!callmebotKey || !whatsappPhone) {
    out('ℹ️  CALLMEBOT_KEY/WHATSAPP_PHONE missing; WhatsApp notifications will be skipped.')
  }

  // 4. gh authenticated (github source only — folder mode never touches gh)
  if (source !== 'folder') {
    const ghAuth = await exec('gh', ['auth', 'status'], { reject: false })
    if (ghAuth.exitCode !== 0) {
      err("❌ gh not authenticated. Run 'gh auth login'.")
      throw new StartAbort('gh not authenticated', 1)
    }
  }

  // 5. .mcp.json validity
  const mcpPath = resolve(cwd, '.mcp.json')
  if (exists(mcpPath)) {
    const mcpCheck = await exec('jq', ['-e', '.', mcpPath], { reject: false })
    if (mcpCheck.exitCode !== 0) {
      err('❌ .mcp.json has invalid JSON')
      throw new StartAbort('invalid .mcp.json', 1)
    }
    const serversResult = await exec(
      'jq',
      ['-r', '.mcpServers | keys | join(", ")', mcpPath],
      { reject: false },
    )
    const servers = (serversResult.stdout || '').trim()
    out(`ℹ️  MCP servers configured: ${servers}`)
    out(
      "   If any MCP's auth has expired, run 'claude' interactively once first to re-authenticate.",
    )
  }

  // 6 + 7. Label creation and orphan cleanup are github-only (they read/write
  // GitHub issue labels). Folder mode tracks progress via the .ralph/tasks
  // status dirs, so it skips both entirely.
  if (source !== 'folder') {
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
        'Ralph loop in progress',
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
        'Ralph loop tried and gave up',
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
      out("⚠️  Issues with the 'claude-working' label (previous run interrupted):")
      out(orphaned)
      out('ℹ️  Keeping labels. These issues will be skipped this run.')
      out('   To reprocess, remove manually: gh issue edit <n> --remove-label claude-working')
    }
  }

  // 8. Queue check — github via gh, folder via the local .ralph/tasks tree.
  let count
  if (source === 'folder') {
    count = String(await getFolderQueueCount(folderQueueCount, cwd))
  } else {
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
    count = (queue.stdout || '').trim()
  }
  if (count === '0' || count === '') {
    out('ℹ️  No issues in the queue. Nothing to do.')
    return { exitCode: 0, started: false }
  }

  // 9. Launch tmux detached, running the bash loop shipped with the package
  const ralphTemplate = templatePath('ralph.sh')
  const tmuxLaunch = await exec(
    'tmux',
    [
      'new',
      '-d',
      '-s',
      session,
      `cd '${cwd}' && RALPH_TMUX_SESSION='${session}' bash '${ralphTemplate}'`,
    ],
    { reject: false },
  )
  if (tmuxLaunch.exitCode !== 0) {
    err(`❌ Failed to start tmux session: ${(tmuxLaunch.stderr || '').trim()}`)
    throw new StartAbort('tmux launch failed', 1)
  }

  // 9b. #62: the digest, as a second window in the session we just created —
  //
  //     session ralph-<slug>-<hash>
  //       window 0            the loop, templates/ralph.sh, the raw agent stream
  //       window 1  digest    ralph digest --loop --interval <RALPH_DIGEST_INTERVAL>
  //
  // A window and not a daemon, a launchd agent or a cron entry: tmux is already a
  // hard dependency of this command, so one `new-window` works the same on macOS,
  // Linux and WSL2; there is nothing to install and nothing to leave behind; both
  // teardown paths already reach it, because `ralph stop` and templates/ralph.sh's
  // end-of-run both kill the SESSION and a session takes its windows with it; and
  // attaching shows the stream and the narration side by side.
  //
  // AFTER the launch above, and only if it succeeded: with no loop there is nothing
  // to narrate, and this run is aborting anyway. Never before it, because opening
  // this window is the one step here allowed to fail quietly.
  //
  // The answer is KEPT, because the launch box below reports it: a window this function
  // refused to open must not be advertised as running (#62 review).
  let digestWindow = null
  if (digest) {
    digestWindow = await openDigestWindow({
      exec,
      err,
      session,
      cwd,
      interval: digest,
      // Trimmed, so a knob edited out by hand with a space left behind reads as absent
      // rather than as an agent named "   ". The model is passed as the config spells it:
      // buildDigestInvocation already reads a blank one as its default.
      agent: parseConfigVar(configText, 'RALPH_AGENT').trim(),
      model: parseConfigVar(configText, 'RALPH_DIGEST_MODEL'),
      ralphBinary,
    })
  }

  // #60: what the queue we just accepted should cost and when it should be done.
  // Every number and every string of it is policy, so it all lives in
  // ../progress.js; this site reads the metrics file and passes the three inputs.
  //
  // BEST-EFFORT twice over: the shared never-throws read every consumer of that
  // file uses (issue-metrics.js), and a projection with no history renders as no
  // lines at all. A missing, unreadable or half-written issues.jsonl costs the
  // reader a hint, never a launch — the loop is already running by this point.
  const projection = buildLaunchProjection({
    metricsText: safeReadMetrics(readFile, metricsPath(cwd)),
    queue: Number(count),
    now: now(),
  })

  out(`✅ Ralph started in background. ${count} issues in the queue.`)
  for (const line of renderLaunchProjection(projection)) out(line)
  out('   Progress:       ralph status')
  // #60's line, and #62 has now made the second half of it literal: the digest runs
  // alongside the loop as window `digest` in the session named two lines below, so
  // `tmux attach` lands on the loop and Ctrl+B then W lists both.
  //
  // Printed whenever the config asked for a digest, and keyed on whether it actually
  // opened. Both halves matter and they used to be traded against each other: keying on
  // the config alone ended a successful-looking launch with `every 0.5h — runs alongside
  // the loop` for a window that had just been refused, with the only correction on
  // stderr, above the box, in a preflight a reader scrolls past. Printing nothing
  // instead would tell a reader with a typo'd interval nothing at all about the knob
  // they had just edited. So: the line always appears, and it says which happened.
  if (digest) {
    out(
      digestWindow?.opened
        ? `   Digest:         every ${digest} — runs alongside the loop`
        : `   Digest:         every ${digest} — NOT running (see the warning on stderr)`,
    )
  }
  out(`   Watch live:     tmux attach -t ${session}`)
  out('   Detach:         inside the session, Ctrl+B then D')
  out('   List:           tmux ls')
  out(`   Kill:           tmux kill-session -t ${session}`)
  out('   Logs:           logs/ralph-issue-*.log')

  // Startup notification — best effort, never blocks startup or surfaces stack traces.
  if (callmebotKey && whatsappPhone) {
    const waResult = await sendWa({
      phone: whatsappPhone,
      apiKey: callmebotKey,
      message: startupMessage,
    })
    if (waResult?.ok) {
      out('📲 Startup WhatsApp notification sent.')
    } else {
      out(`⚠️  Startup WhatsApp notification failed: ${waResult?.reason ?? 'unknown'}.`)
    }
  }

  return { exitCode: 0, started: true, count: Number(count) }
}

// #62: open the digest's window, or explain why there isn't one. NEVER THROWS, and
// that is the whole contract of this function: the loop is already running by the
// time it is called, so every failure below costs the reader a narration and nothing
// else. A warning on stderr, and the launch continues.
//
// The WHY goes to stderr and the FACT goes to the caller: the diagnostic is about
// Ralph's plumbing and belongs in the stream a script can discard, but whether there
// is a digest is part of this command's answer about the run, so `{ opened }` is
// returned rather than dropped and the launch box keys its Digest line on it. A repo
// that configures no digest reaches neither, and its box is unchanged.
async function openDigestWindow({ exec, err, session, cwd, interval, agent, model, ralphBinary }) {
  // Validated HERE rather than left to the window: `ralph digest --loop` would reject
  // it too, but in a pane nobody is attached to yet, hours before anyone notices. The
  // shared grammar (../duration.js) is the same one `ralph schedule` uses, so the
  // fractional interval a user is most likely to reach for (`0.5h`) is rejected here
  // exactly as it is there — and the message names the formats that do work.
  //
  // parseTimerDuration and not parseDuration, because this window's whole job is to
  // WAIT: `RALPH_DIGEST_INTERVAL=30d` is a duration a timer cannot hold, and opening a
  // window for it would start a digest per millisecond (#62 QA). The loop in the window
  // refuses exactly this set, from the same function — the agreement is shared code,
  // not a number written down twice.
  try {
    parseTimerDuration(interval)
  } catch (e) {
    err(`⚠️  Digest window not opened — ${oneLine(e?.message)}. The loop is running.`)
    return { opened: false, reason: 'invalid-interval' }
  }

  // BOTH knobs, and the agent is not optional (#62 review): `ralph digest` resolves its
  // agent from `env.RALPH_AGENT` and `ralph start` never sources ralph.config.sh, so a
  // repo on codex that only forwarded the model would open a window running
  // `claude --model gpt-5-mini` — every tick failing, in a pane nobody is attached to,
  // while the launch box advertised a digest all night.
  //
  // Each assignment is emitted ONLY when the config actually sets it, so a repo that
  // configures neither gets the same bare command it always did and inherits whatever
  // the ambient environment says — the same resolution order every other Ralph command
  // uses. Quoted, not interpolated: every value here comes from outside this process (a
  // path, two config values, argv[1]) and this string is handed to a shell.
  const envPrefix =
    (agent ? `RALPH_AGENT=${shellQuote(agent)} ` : '') +
    (model ? `RALPH_DIGEST_MODEL=${shellQuote(model)} ` : '')
  const command =
    `cd ${shellQuote(cwd)} && ${envPrefix}${shellQuote(ralphBinary)} ` +
    `digest --loop --interval ${shellQuote(interval)}`

  // `-d` so window 0 stays the one an attach lands on, and `-n digest` because an
  // index is not a promise: a user's own base-index setting moves the number, but
  // `tmux kill-window -t <session>:digest` keeps working whatever it is.
  let result
  try {
    result = await exec(
      'tmux',
      ['new-window', '-d', '-t', session, '-n', DIGEST_WINDOW, command],
      { reject: false },
    )
  } catch (e) {
    // `reject: false` covers a tmux that answers non-zero; this covers a tmux that
    // cannot be spawned at all.
    err(`⚠️  Digest window not opened — ${oneLine(e?.message) || 'tmux could not be run'}. The loop is running.`)
    return { opened: false, reason: 'spawn-failed' }
  }
  if (result?.exitCode !== 0) {
    const why = oneLine(result?.stderr) || `tmux new-window exited ${result?.exitCode}`
    err(`⚠️  Digest window not opened — ${why}. The loop is running.`)
    return { opened: false, reason: 'tmux-failed' }
  }
  return { opened: true, window: DIGEST_WINDOW }
}

// One shell word, whatever is in it — POSIX single quotes, with an embedded quote
// spliced as '\''. Cheaper than pulling in a dependency, and the only escaping this
// file needs. Deliberately not shared with agent-invocation.js's `shQuote`: that one
// is a private detail of the bash bridge and renders a nullish value as the literal
// `undefined`, which is right for an argv element it must not silently drop and wrong
// for a config value that is simply absent here.
function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

// #565: default folder-queue counter — counts .md tasks in .ralph/tasks/afk/
// todo via the folder-queue library. Injectable in tests via folderQueueCount.
function defaultFolderQueueCount({ cwd }) {
  return folderQueueCountLib(resolve(cwd, '.ralph', 'tasks'))
}

async function getFolderQueueCount(folderQueueCount, cwd) {
  try {
    const n = await folderQueueCount({ cwd })
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

// #68: the newest version the last update check left in the global cache, or null.
//
// TOTAL, on purpose, and the try/catch is load-bearing rather than defensive: this runs
// before the first preflight line of every `ralph start`, and readVersionCache is total
// for a bad FILE but not for a bad ARGUMENT — its `path` default parameter evaluates
// before its own try blocks, so a non-string `home` or a truthy non-string
// XDG_CONFIG_HOME throws a TypeError straight out of join(). A corrupt, hostile or
// unreadable cache costs a HINT; it must never cost the run. Same guard, for the same
// reason, that resolveUpdateDecision puts around its own read.
//
// The `latest_version` type check is not redundant with normalizeCache's: an injected
// `readCache` is a seam a caller controls, so what comes back here is not guaranteed to
// have been through it.
//
// THE OPT-OUT IS HONORED HERE, and `ralph doctor`'s otherwise-identical helper
// deliberately does not honor it — the difference is what the two lines ARE. Doctor's
// version line is a diagnostic: it reports the cache's contents to a user who asked
// what state their install is in. This hint is the same nagging `RALPH_NO_UPDATE_CHECK`
// exists to switch off, printed above every single `ralph start`. Reading the cache
// anyway would also break the promise update-check.js states for that path — "reads no
// cache at all" — which two QA suites pin as zero operations on the injected cache fs.
function cachedLatestVersion({ readCache, fs, processEnv, home }) {
  if (isUpdateCheckDisabled(processEnv)) return null
  try {
    const cache = readCache({ fs, processEnv, home })
    return typeof cache?.latest_version === 'string' ? cache.latest_version : null
  } catch {
    return null
  }
}

function ageInHours(nowMs, isoStartedAt) {
  if (!isoStartedAt) return 0
  const startMs = Date.parse(isoStartedAt)
  if (!Number.isFinite(startMs)) return 0
  return Math.max(0, Math.round((nowMs - startMs) / 3600000))
}

export { StartAbort }
