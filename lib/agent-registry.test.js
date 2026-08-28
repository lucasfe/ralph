import { describe, it, expect } from 'vitest'
import { resolveAgent, agentSpec } from './agent-registry.js'

describe('resolveAgent — reads RALPH_AGENT from env', () => {
  it('defaults to claude when RALPH_AGENT is unset', () => {
    expect(resolveAgent({})).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
  })

  it('defaults to claude when RALPH_AGENT is empty/whitespace', () => {
    expect(resolveAgent({ RALPH_AGENT: '' }).agent).toBe('claude')
    expect(resolveAgent({ RALPH_AGENT: '   ' }).agent).toBe('claude')
    expect(resolveAgent({ RALPH_AGENT: '' }).fellBack).toBe(false)
  })

  it('resolves an explicit claude value', () => {
    expect(resolveAgent({ RALPH_AGENT: 'claude' })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
  })

  it('resolves an explicit codex value', () => {
    expect(resolveAgent({ RALPH_AGENT: 'codex' })).toEqual({
      agent: 'codex',
      fellBack: false,
      warning: null,
    })
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(resolveAgent({ RALPH_AGENT: '  CODEX ' }).agent).toBe('codex')
    expect(resolveAgent({ RALPH_AGENT: 'Claude' }).agent).toBe('claude')
  })

  it('falls back to claude on an unrecognized value, resolved==fallback', () => {
    const r = resolveAgent({ RALPH_AGENT: 'codx' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toBe(
      "RALPH_AGENT='codx' unrecognized; falling back to 'claude'. Valid: claude, codex.",
    )
  })

  it('preserves the ORIGINAL (untrimmed/original-case) value in the warning', () => {
    const r = resolveAgent({ RALPH_AGENT: ' GPT ' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT=' GPT '")
  })

  it('tolerates a missing/undefined env argument', () => {
    expect(resolveAgent().agent).toBe('claude')
  })
})

// The exact static argv template Claude has always used — asserted here so a
// drift in the registry is caught (the Claude pipeline must stay unchanged).
const CLAUDE_ARGV = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
]

// The static base Codex argv (env-dependent `-m <model>` and the `-` stdin
// marker are composed in agent-invocation.js, NOT here).
const CODEX_ARGV = [
  'exec',
  '--json',
  '--sandbox',
  'workspace-write',
  '-c',
  'approval_policy="never"',
  '-c',
  'sandbox_workspace_write.network_access=true',
]

describe('agentSpec — per-agent knowledge', () => {
  it('returns the claude spec', () => {
    expect(agentSpec('claude')).toEqual({
      cli: 'claude',
      orchestratorTemplate: 'prompt-team.md',
      dependency: 'claude',
      authProbe: 'credentials-file',
      argv: CLAUDE_ARGV,
      streamFilter: expect.any(String),
      env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1800000' },
      // The one-shot digest invocation (#61). Its own shape is pinned field by
      // field in agent-registry.digest.test.js; here it only has to be PRESENT,
      // so this exact-shape assertion keeps covering the loop's own fields.
      digest: expect.any(Object),
    })
  })

  it('returns the codex spec', () => {
    expect(agentSpec('codex')).toEqual({
      cli: 'codex',
      orchestratorTemplate: 'prompt-team-codex.md',
      dependency: 'codex',
      authProbe: 'login-status',
      argv: CODEX_ARGV,
      streamFilter: expect.any(String),
      env: {},
      digest: expect.any(Object),
    })
  })

  it('throws on an unknown agent', () => {
    expect(() => agentSpec('gpt')).toThrow()
    expect(() => agentSpec()).toThrow()
  })

  it('claude raises the background-wait ceiling well above the 10-minute default', () => {
    // The number matters, not just its presence: the default terminated three
    // invocations that were still waiting on a dispatched subagent. Anything at
    // or below 600000 would reintroduce that.
    const ceiling = Number(agentSpec('claude').env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS)
    expect(ceiling).toBeGreaterThan(600_000)
    // And NOT unbounded: 0 means "wait forever", which trades one lost issue for
    // a permanently stalled queue.
    expect(ceiling).not.toBe(0)
    expect(Number.isFinite(ceiling)).toBe(true)
  })

  it('a caller mutating the returned env cannot corrupt the registry', () => {
    const first = agentSpec('claude')
    first.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '1'
    delete first.env.SOMETHING
    first.env.INJECTED = 'yes'
    expect(agentSpec('claude').env).toEqual({
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1800000',
    })
  })
})

// ---------------------------------------------------------------------------
// AC#5 (#555): the spec is now COMPLETE — it carries the static argv template
// AND the jq output-stream filter, so bash holds no agent knowledge.
// ---------------------------------------------------------------------------

describe('agentSpec — argv static template (AC#5)', () => {
  it('claude argv is the exact 6-flag stream-json template', () => {
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
  })

  it('codex argv is the exact static base (no -m, no stdin marker)', () => {
    const argv = agentSpec('codex').argv
    expect(argv).toEqual(CODEX_ARGV)
    expect(argv).not.toContain('-m')
    expect(argv).not.toContain('-')
  })

  it('returns a fresh argv array copy each call (no shared mutation)', () => {
    const a = agentSpec('claude').argv
    a.push('HACKED')
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
  })
})

describe('agentSpec — streamFilter jq program (AC#5)', () => {
  it('claude has a non-empty jq filter string rendering stream-json events', () => {
    const f = agentSpec('claude').streamFilter
    expect(typeof f).toBe('string')
    expect(f.length).toBeGreaterThan(0)
    expect(f).toContain('fromjson? // empty')
    expect(f).toContain('.type == "assistant"')
    expect(f).toContain('==> result: ')
  })

  // #15: the claude filter surfaces tool_use as informative `⏺ ToolName(hint)`
  // lines and DROPS the old contentless `↳ tool_result` flood entirely.
  it('claude filter surfaces tool_use (not the tool_result flood) (#15)', () => {
    const f = agentSpec('claude').streamFilter
    // Renders tool_use blocks with the ⏺ glyph...
    expect(f).toContain('tool_use')
    expect(f).toContain('⏺')
    // ...and no longer emits the contentless tool_result placeholder.
    expect(f).not.toContain('tool_result')
    expect(f).not.toContain('↳')
    // The hint field precedence is present.
    expect(f).toContain('.command')
    expect(f).toContain('.file_path')
    expect(f).toContain('.pattern')
    expect(f).toContain('.description')
  })

  // #39: the claude result event's `is_error` flag outranks its `subtype`, so the
  // filter must consult it (a stream-json `result` can claim subtype "success"
  // while flagging is_error true).
  it('claude filter guards the result line with .is_error (#39)', () => {
    const f = agentSpec('claude').streamFilter
    expect(f).toContain('.is_error')
  })

  it('codex has a non-empty jq filter string rendering codex JSONL events', () => {
    const f = agentSpec('codex').streamFilter
    expect(typeof f).toBe('string')
    expect(f.length).toBeGreaterThan(0)
    expect(f).toContain('fromjson? // empty')
    expect(f).toContain('item.completed')
    expect(f).toContain('turn.completed')
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#554): adversarial RALPH_AGENT inputs + spec-throw guards.
// ---------------------------------------------------------------------------

describe('QA: resolveAgent — adversarial RALPH_AGENT values', () => {
  it('tab / newline-only whitespace is treated as unset (=> claude, no fallback)', () => {
    expect(resolveAgent({ RALPH_AGENT: '\t' })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
    expect(resolveAgent({ RALPH_AGENT: '\n\n' }).fellBack).toBe(false)
  })

  it('codex with tab/newline padding still resolves to codex', () => {
    expect(resolveAgent({ RALPH_AGENT: '\tcodex\n' }).agent).toBe('codex')
  })

  it('mixed-case CLAUDE / cOdEx resolve without fallback', () => {
    expect(resolveAgent({ RALPH_AGENT: 'CLAUDE' })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
    expect(resolveAgent({ RALPH_AGENT: 'cOdEx' }).agent).toBe('codex')
    expect(resolveAgent({ RALPH_AGENT: 'cOdEx' }).fellBack).toBe(false)
  })

  it('a numeric value falls back to claude with a warning naming it', () => {
    const r = resolveAgent({ RALPH_AGENT: '42' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT='42'")
    expect(r.warning).toContain("falling back to 'claude'")
  })

  it('a value that merely CONTAINS a valid name (substring) still falls back', () => {
    // guards against a loose includes()-style match
    const r = resolveAgent({ RALPH_AGENT: 'codex-turbo' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT='codex-turbo'")
  })

  it('the fallback warning both names the bad value AND lists valid agents', () => {
    const r = resolveAgent({ RALPH_AGENT: 'gemini' })
    expect(r.warning).toContain("RALPH_AGENT='gemini'")
    expect(r.warning).toContain('claude, codex')
  })

  it('a non-string RALPH_AGENT (number) is stringified and falls back', () => {
    const r = resolveAgent({ RALPH_AGENT: 7 })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
  })

  it('an all-whitespace-then-typo value is trimmed before matching but echoed raw', () => {
    const r = resolveAgent({ RALPH_AGENT: '   codx   ' })
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
    expect(r.warning).toContain("RALPH_AGENT='   codx   '")
  })
})

describe('QA: agentSpec — returns an independent copy (no shared mutation)', () => {
  it('mutating a returned spec does not affect the next call', () => {
    const a = agentSpec('codex')
    a.cli = 'HACKED'
    expect(agentSpec('codex').cli).toBe('codex')
  })

  it('throws with a message naming the bad agent + valid list', () => {
    expect(() => agentSpec('gemini')).toThrow(/gemini/)
    expect(() => agentSpec('gemini')).toThrow(/claude, codex/)
  })

  it('throws (not returns undefined) for null / empty-string agent', () => {
    expect(() => agentSpec(null)).toThrow()
    expect(() => agentSpec('')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// QA augmentation (#555): registry immutability is COMPLETE, and streamFilter
// content is a real jq program (not a placeholder). The registry is the single
// source of agent knowledge, so a caller corrupting a returned value must never
// leak back into the next reader.
// ---------------------------------------------------------------------------

describe('QA: agentSpec — returned argv is fully insulated from mutation', () => {
  it('push()-ing onto the returned argv does not affect the next call', () => {
    const first = agentSpec('claude').argv
    first.push('--evil')
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
    expect(agentSpec('claude').argv).not.toContain('--evil')
  })

  it('splice()-ing the returned argv does not affect the next call', () => {
    const first = agentSpec('codex').argv
    first.splice(0, first.length) // empty it out entirely
    expect(first.length).toBe(0)
    expect(agentSpec('codex').argv).toEqual(CODEX_ARGV)
  })

  it('reverse()-ing the returned argv (in-place) does not affect the next call', () => {
    const first = agentSpec('claude').argv
    first.reverse()
    // The mutated copy is reversed...
    expect(first[0]).toBe('--include-partial-messages')
    // ...but the registry still yields the original order.
    expect(agentSpec('claude').argv).toEqual(CLAUDE_ARGV)
  })

  it('two successive calls return DISTINCT argv array instances', () => {
    expect(agentSpec('codex').argv).not.toBe(agentSpec('codex').argv)
  })
})

describe('QA: agentSpec — scalar fields are insulated by the top-level spread', () => {
  it('reassigning a returned scalar (dependency, orchestratorTemplate) is harmless', () => {
    const s = agentSpec('claude')
    s.dependency = 'HACKED'
    s.orchestratorTemplate = 'evil.md'
    s.authProbe = 'nope'
    const fresh = agentSpec('claude')
    expect(fresh.dependency).toBe('claude')
    expect(fresh.orchestratorTemplate).toBe('prompt-team.md')
    expect(fresh.authProbe).toBe('credentials-file')
  })

  it('reassigning a returned streamFilter does not corrupt the registry', () => {
    // Strings are immutable; a caller can only REASSIGN the property on their
    // own copy. Prove that reassignment cannot leak into the next reader.
    const original = agentSpec('codex').streamFilter
    const s = agentSpec('codex')
    s.streamFilter = 'evil // empty'
    expect(agentSpec('codex').streamFilter).toBe(original)
    expect(agentSpec('codex').streamFilter).not.toBe('evil // empty')
  })
})

describe('QA: agentSpec — streamFilter is a real jq program, not a placeholder', () => {
  it('both filters begin with fromjson? and expose a "==> result:" line', () => {
    for (const agent of ['claude', 'codex']) {
      const f = agentSpec(agent).streamFilter
      expect(typeof f).toBe('string')
      // A non-trivial program (guards against an accidental empty/one-token filter).
      expect(f.trim().length).toBeGreaterThan(20)
      // Must start the pipeline by parsing the JSON line safely.
      expect(f.startsWith('fromjson?')).toBe(true)
      // Must emit the sentinel the pretty-printer relies on; an empty or
      // placeholder filter would silently blank the rendered log.
      expect(f).toContain('==> result:')
    }
  })
})

// ---------------------------------------------------------------------------
// #108 — the warning is ONE line, and the echo inside it is still an echo.
//
// The defect: this function interpolated the RAW value into its warning, and its two printing
// callers — `ralph doctor` (lib/commands/doctor.js) and `ralph init` (lib/commands/init.js) —
// write that warning as one line each. So a RALPH_AGENT holding a newline made one write emit
// TWO terminal lines, the second composed by nobody. Since #75 doctor heads its report with a
// framed identity box, so the forged line lands among frame glyphs and reads as one of the
// box's rows in a pasted bug report, which is exactly what doctor's output is for.
//
// FIXED HERE RATHER THAN AT THE TWO CALL SITES, which is the whole shape of the fix: the
// wording is this module's, so the guarantee about the wording is this module's too, and a
// third caller inherits it instead of having to remember it. The value is passed through
// `oneLineEcho` (lib/one-line.js) — a module that imports nothing, because doctor's import
// graph may not grow an exec dependency to print a warning.
//
// The contract is SANITISED, NOT NORMALISED: the echo is still the original, untrimmed,
// original-case value, because the point of the message is that the user recognises what they
// typed. The tests above pin that half, and this block must not cost them.
// ---------------------------------------------------------------------------

describe('QA: resolveAgent — one line per warning, whatever the value holds (#108)', () => {
  // Built from code points, never typed: a raw control byte in a test file makes the file
  // invisible to grep and the terminal print it (#107).
  const NUL = String.fromCharCode(0x00)
  const BEL = String.fromCharCode(0x07)
  const LF = String.fromCharCode(0x0a)
  const CR = String.fromCharCode(0x0d)
  const ESC = String.fromCharCode(0x1b)
  const DEL = String.fromCharCode(0x7f)
  const NEL = String.fromCharCode(0x85)
  const C1_CSI = String.fromCharCode(0x9b)
  const LINE_SEP = String.fromCharCode(0x2028)
  const PLACEHOLDER = String.fromCharCode(0xfffd)

  const isControlCode = (code) =>
    code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
  const controlsIn = (text) => [...String(text)].map((c) => c.codePointAt(0)).filter(isControlCode)

  it('the issue’s own reproduction: a value that forged a box row now forges nothing', () => {
    const hostile = `x${LF}│ cwd     /elsewhere`
    const r = resolveAgent({ RALPH_AGENT: hostile })
    expect(r.warning.split('\n')).toHaveLength(1)
    expect(r.warning).toBe(
      `RALPH_AGENT='x${PLACEHOLDER}│ cwd     /elsewhere' unrecognized; falling back to 'claude'. Valid: claude, codex.`,
    )
    // The resolution itself never depended on the wording and must not start to.
    expect(r.agent).toBe('claude')
    expect(r.fellBack).toBe(true)
  })

  it('leaves nothing in the warning that can end a line or command a terminal', () => {
    // Swept as a CLASS rather than as the two characters the bug was reported with: CR redraws
    // over what is already on the line, NEL and U+2028 end a line without being `\s`, and the
    // C1 introducer is a CSI with no ESC in front of it.
    for (const [label, char] of Object.entries({ NUL, BEL, LF, CR, ESC, DEL, NEL, C1_CSI, LINE_SEP })) {
      const { warning } = resolveAgent({ RALPH_AGENT: `co${char}dx` })
      expect(controlsIn(warning), label).toEqual([])
      expect(warning.split('\n'), label).toHaveLength(1)
      // ...and REPLACED, not stripped: a value with a NUL in the middle of it is not the value
      // `codx`, and a warning that said it was would misreport what the user set (the argument
      // lib/banner-compose.js writes out for the identity box's own facts).
      expect(warning, label).toContain(`RALPH_AGENT='co${PLACEHOLDER}dx'`)
    }
  })

  it('still echoes the untrimmed, original-case value — sanitised is not normalised', () => {
    // The trap this fix could have walked into: `oneLine` (the diagnostic flattener next door)
    // also trims and collapses runs of whitespace, and reaching for it here would have quietly
    // reworded `'   codx   '` as `'codx'` — breaking the promise two tests above already make.
    expect(resolveAgent({ RALPH_AGENT: '   codx   ' }).warning).toContain("RALPH_AGENT='   codx   '")
    expect(resolveAgent({ RALPH_AGENT: ' GPT ' }).warning).toContain("RALPH_AGENT=' GPT '")
    expect(resolveAgent({ RALPH_AGENT: 'GpT  9000' }).warning).toContain("RALPH_AGENT='GpT  9000'")
  })

  it('adds nothing to a value that was already printable', () => {
    // No formatting, no shell, no quoting: the sentence is built by interpolating one string.
    for (const value of ['codx', 'gpt-9000', '%s%s%n', '${HOME}', '`whoami`', '$(rm -rf /)']) {
      expect(resolveAgent({ RALPH_AGENT: value }).warning, value).toBe(
        `RALPH_AGENT='${value}' unrecognized; falling back to 'claude'. Valid: claude, codex.`,
      )
    }
  })

  it('caps a hundred-thousand-character value rather than filling the terminal with it', () => {
    // `ralph doctor` prints this warning into a report people paste, and `ralph init` prints it
    // to stderr; neither caller caps, so the cap is here.
    const { warning } = resolveAgent({ RALPH_AGENT: 'x'.repeat(100_000) })
    expect(warning.split('\n')).toHaveLength(1)
    // The bound belongs to the VALUE, not to the sentence, so it is asserted where it applies:
    // 200 characters between the quotes (lib/one-line.js's DIAGNOSTIC_MAX_CHARS), the last of
    // them the ellipsis that says there was more. The sentence is that plus its own boilerplate,
    // which is fixed — checked loosely, because pinning its exact length here would just be a
    // second copy of the wording two tests above already pin character for character.
    const echoed = warning.slice(warning.indexOf("'") + 1, warning.lastIndexOf("' unrecognized"))
    expect(echoed).toHaveLength(200)
    expect(echoed.endsWith('…')).toBe(true)
    expect(warning).toContain("RALPH_AGENT='xxx")
    expect(warning.length).toBeLessThan(300)
  })

  it('says nothing at all when the control character is only padding around a real agent', () => {
    // The other half of "one line": a value that RESOLVES earns no warning to be one line of.
    // Both of these trim to a registered name, so the fallback never fires.
    expect(resolveAgent({ RALPH_AGENT: `codex${LF}` }).warning).toBe(null)
    expect(resolveAgent({ RALPH_AGENT: `${CR}${LF} claude ` })).toEqual({
      agent: 'claude',
      fellBack: false,
      warning: null,
    })
  })
})
