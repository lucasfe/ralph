// #23: what a failed install should SAY. Text in, display-ready lines out — no
// spawning, no streams — so every wording and bound below is testable without a
// package manager, and update.js keeps one branch per failure instead of a
// diagnostics block bolted into it.
//
// The lines come back already indented, one whole line each, because every
// message in update.js is written as a single `write(line + '\n')`: a helper that
// returned one blob would break that contract on the first multi-line npm log.

// The bound. A failing install can flood in two directions — a 200k-line log,
// and one minified line — so both are clipped, and both clips are marked with `…`
// exactly like the tool-hint clip in agent-registry.js (#15/#17): a truncated
// tail must never read as complete. The TAIL is what carries the diagnosis, since
// npm prints its error code at the END of the log.
const TAIL_LINES = 12
const TAIL_COLUMNS = 200

// How a package manager says "you may not write there". npm prints `EACCES` with
// `errno -13`, Windows reports `EPERM` for the same thing, and pnpm/yarn/bun
// mostly pass the OS message straight through — so the signal is a list of
// patterns matched against everything the failure carries, never a per-manager
// branch. `\b` cannot sit in front of `-13` (a hyphen is not a word character),
// hence the explicit `errno` prefix there.
const PERMISSION_SIGNALS = [
  /\bEACCES\b/,
  /\bEPERM\b/,
  /errno:?\s*-13\b/,
  /permission denied/i,
  /operation not permitted/i,
]

// The "make the global install directory yours" fix, per manager, keyed on the
// command that actually ran (argv[0]) — never on the classification's kind, and
// never assumed to be npm. Naming the wrong knob is worse than naming none, so
// anything absent here gets the generic wording below.
//
// `fix` is the command to run. The two optional fields exist so that a manager
// which does not work the way npm does can say so as DATA rather than as a branch
// in permissionHint, the same way a GLOBAL_STORES row in install-target.js
// overrides its own derived wording (#198):
//   `lead` replaces "Point it somewhere you own" for a fix that does not point
//          the manager anywhere.
//   `rootAborts` drops the elevated-privileges line for a manager that refuses to
//          run under sudo at all — where offering it is the same error as naming
//          the wrong knob. Named for the manager's behavior, not for the line it
//          suppresses, and true-or-absent so the default needs no strict compare.
const PERMISSION_FIX = {
  npm: { fix: 'npm config set prefix ~/.npm-global' },
  // pnpm's global directory follows PNPM_HOME, which `pnpm setup` writes.
  pnpm: { fix: 'pnpm setup' },
  yarn: { fix: 'yarn config set prefix ~/.yarn' },
  bun: { fix: 'export BUN_INSTALL="$HOME/.bun"' },
  // #198: Homebrew, the one manager here where BOTH generic lines are unrunnable,
  // so it needs its own row rather than the fallback.
  //
  // There is nowhere to point it: brew's prefix is fixed per platform
  // (`/opt/homebrew`, `/usr/local`, `/home/linuxbrew/.linuxbrew`) and settled when
  // brew itself was installed — `brew config` only prints configuration
  // (Library/Homebrew/cmd/config.rb declares `named_args :none`), so there is no
  // `brew config set prefix` to name.
  //
  // What fixes a Cellar you cannot write to is taking ownership of it, and this
  // row names `brew doctor` rather than a chown of its own for three reasons, in
  // increasing order of how badly a hand-written chown gets it wrong:
  //   1. The set of directories that must be writable is brew's to compute, not
  //      ours: `Keg.must_be_writable_directories` (Library/Homebrew/keg.rb) is a
  //      list of prefix subdirectories PLUS `HOMEBREW_CACHE`, `HOMEBREW_CELLAR`,
  //      `HOMEBREW_LOCKS`, `HOMEBREW_LOGS`, `HOMEBREW_REPOSITORY` and
  //      `Language::Python.homebrew_site_packages`. The cache is not under the
  //      prefix on macOS (`brew --cache` is `~/Library/Caches/Homebrew`), and this
  //      formula builds from a source tarball, so a root-owned cache is a live way
  //      for `brew upgrade` to fail with a permission error that no chown of the
  //      prefix could fix.
  //   2. A chown wide enough to look safe is too wide to be safe: on an Intel
  //      `/usr/local` the prefix is shared with software Homebrew did not install,
  //      and brew's own documentation rules the blanket form out — "Do not
  //      recursively change ownership or permissions for the entire Caskroom or
  //      Homebrew prefix without first identifying the incorrect path and its
  //      expected owner" (docs/Common-Issues.md).
  //   3. `brew doctor` IS that identification step (docs/Troubleshooting.md lists
  //      it as step 3, before any correction), and having found the unwritable
  //      directories it prints the exact remedy for them: "You should change the
  //      ownership of these directories to your user. sudo chown -R <user> <dirs>"
  //      (Library/Homebrew/diagnostic.rb, check_access_directories). So this line
  //      hands over one safe command that produces the right chown, instead of a
  //      paste-ready recursive one that may be both incomplete and too broad.
  //
  // And `sudo brew upgrade` is not a fallback: brew aborts outright when it is run
  // as root — "Running Homebrew as root is extremely dangerous and no longer
  // supported" (Library/Homebrew/brew.sh, check-run-command-as-root, which exempts
  // only `services`, `as-console-user`, `setup-sandbox`, `--prefix` and container
  // environments, and not `upgrade`). Hence `rootAborts`: the line is dropped, not
  // reworded, because there is no elevated form of this command to offer.
  brew: {
    lead: 'Find the directories to take ownership of',
    fix: 'brew doctor',
    rootAborts: true,
  },
}

// The lines to print UNDER a failure headline: what the failure said (bounded),
// then a hint when the text names a cause the user can act on.
//
// `failure` is whatever the install call produced — the object execa resolves for
// a command that ran and failed OR one that could not be spawned at all, and the
// error it throws for a misused option. All of them carry the same fields
// (stderr/stdout/shortMessage/message/code), which is why one function serves both
// call sites; a broken stub that produced nothing at all still gets a line.
export function installFailureDetails(failure, target = {}) {
  const manager = target.argv?.[0] || 'the install command'
  // The command as a user could re-run it. update.js reaches here only past its
  // `!target.argv?.length` guard, so in the shipped path the first alternative on
  // this line and on the one above always wins. Both defaults exist for direct
  // callers of this pure export — a stub, a future call site, the tests — where
  // naming nothing would print `undefined` inside a line the user is invited to
  // paste, and `sudo undefined` is worse than no fix at all.
  const label = target.label || target.argv?.join(' ') || manager
  const output = failureOutput(failure)
  const said = output
    ? [output.header(manager), ...boundedTail(output.text).map((line) => `     ${line}`)]
    : [noOutputLine(manager, label)]
  return [...said, ...permissionHint(failure, manager, label)]
}

// Where the text comes from, in order, and what to call it. stderr first, then
// stdout (some managers report the error there), and only then the failure's own
// message — which is the ONLY carrier of the cause for a command that could not be
// spawned: `reject: false` makes execa RESOLVE that case with `exitCode`
// undefined, both streams empty and `spawn npm ENOENT` in the message alone, so
// dropping it would tell the user to re-run the command that cannot run, and would
// leave an `EACCES` on the binary itself looking like an unwritable install
// directory. `shortMessage` comes first because an ExecaError's `message` embeds
// the whole subprocess output by design (execa/types/return/result.d.ts) — taking
// it before stderr would smuggle an unbounded log past the tail below.
const STREAM_HEADER = (manager) => `   ${manager} wrote:`
const MESSAGE_HEADER = (manager) => `   ${manager} printed no output; the error reads:`

const OUTPUT_SOURCES = [
  { field: 'stderr', header: STREAM_HEADER },
  { field: 'stdout', header: STREAM_HEADER },
  { field: 'shortMessage', header: MESSAGE_HEADER },
  { field: 'message', header: MESSAGE_HEADER },
]

function failureOutput(failure) {
  for (const { field, header } of OUTPUT_SOURCES) {
    const text = String(failure?.[field] ?? '').trim()
    if (text) return { text, header }
  }
  return null
}

// The bounded, one-line form of what a failure says, for a caller's headline.
// Neither execa field is either of those on its own: the TypeError thrown for a
// misused option spans two lines, and an ExecaError's `message` carries the whole
// subprocess log — a headline interpolating it raw would write several lines at
// once AND bypass the bound this module exists to enforce. Empty when the failure
// says nothing, so the caller can leave its parenthetical off rather than print
// `()`.
export function failureCause(failure) {
  const said = String(failure?.shortMessage || failure?.message || '')
  return clip(said.split('\n')[0].trim())
}

// Silence is worse than a fallback: with no output and no cause, the only useful
// thing left to say is which command to run to see the failure for yourself.
function noOutputLine(manager, label) {
  return `   ${manager} printed no output. Run \`${label}\` yourself to see it.`
}

function boundedTail(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  const dropped = lines.length - TAIL_LINES
  const kept = lines.slice(-TAIL_LINES).map(clip)
  if (dropped <= 0) return kept
  return [`… ${dropped} earlier line${dropped === 1 ? '' : 's'} omitted`, ...kept]
}

const clip = (line) =>
  line.length > TAIL_COLUMNS ? `${line.slice(0, TAIL_COLUMNS - 1)}…` : line

// A root-owned global prefix is by far the most common real-world failure, so it
// gets the fixes that actually work instead of only the raw error text — two of
// them for a manager with an elevated form, and (#198) one for a `rootAborts` row,
// where re-running as root is not a fix at all.
function permissionHint(failure, manager, label) {
  const text = failureText(failure)
  if (!PERMISSION_SIGNALS.some((signal) => signal.test(text))) return []
  // `hasOwn`, because `manager` is argv[0]: an inherited key (`constructor`,
  // `toString`) must not answer for a fix Ralph does not have.
  const row = Object.hasOwn(PERMISSION_FIX, manager) ? PERMISSION_FIX[manager] : null
  return [
    // Not "the install directory is not writable by you": the same codes come back
    // when the manager's own binary is not executable, and the raw text above is
    // what tells those apart. The hint names the usual cause and the fixes for it
    // without asserting a diagnosis it cannot make.
    '   That is a permission error — usually a global install directory you do not own.',
    row
      ? `     ${row.lead ?? 'Point it somewhere you own'}: \`${row.fix}\``
      : `     Point it somewhere you own (see ${manager}'s global-prefix setting).`,
    // #198: no longer unconditional. `rootAborts` is one row's data and absent
    // everywhere else, so this line stays the default for every manager that has
    // an elevated form, and is gone only where re-running as root cannot work.
    ...(row?.rootAborts
      ? []
      : [`     Or re-run this install with elevated privileges: \`sudo ${label}\``]),
  ]
}

// Everything the failure carries, as one string to match the signals against: a
// command that never ran (EACCES on the binary itself) has no output at all, and
// the thrown `message`/`code` are then the only place the cause appears. This list
// differs from OUTPUT_SOURCES at both ends on purpose: `code` carries the signal but
// is not printable prose (a lone `EACCES` line tells a user nothing), and
// `shortMessage` would be redundant because an ExecaError's `message` already
// contains it (execa/types/return/result.d.ts), so matching `message` matches both.
// Reading all of it unbounded is free — nothing here is printed, only matched, and
// matching before the tail is clipped is what keeps the hint alive for a real npm
// log whose `code EACCES` sits above the 12 lines that survive.
const failureText = (failure) =>
  ['stderr', 'stdout', 'message', 'code']
    .map((field) => String(failure?.[field] ?? ''))
    .join('\n')
