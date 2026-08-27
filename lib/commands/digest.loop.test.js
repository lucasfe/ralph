import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { digestCommand } from './digest.js'

// #62 — `ralph digest --loop --interval 30m`: the same one-shot digest, on a timer,
// until something kills it. It exists because a task takes 40-100 minutes, so a
// half-hourly digest cannot ride on iteration boundaries — it needs a clock of its
// own. `ralph start` gives it one as a second tmux window beside the loop.
//
// Everything about the timer is INJECTED here: `sleep` records what would have been
// waited (a real 30-minute await in a unit test is not a test), and `shouldContinue`
// is what a SIGTERM is in the field — the only reason the loop ever ends. No test in
// this file waits for anything or spawns an agent.

const NARRATIVE = '#062 is in the TDD red phase.\nMain is 3 commits ahead of origin/main.'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

const okResult = (n) => ({
  status: 'ok',
  narrative: `digest ${n}: ${NARRATIVE}`,
  diagnostic: null,
  model: 'haiku',
  task: '#062',
  now: Date.parse('2026-08-26T04:40:12Z'),
})

// A looping digest with a bounded clock: `runs` digests, then the loop is told to
// stop the way a killed pane tells it.
const loopDeps = ({ runs = 3, result = okResult, interval = '30m', ...overrides } = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const calls = []
  const sleeps = []
  let ticks = 0
  return {
    cwd: '/repo',
    env: {},
    stdout,
    stderr,
    loop: true,
    interval,
    run: async (bag) => {
      calls.push(bag)
      ticks += 1
      return typeof result === 'function' ? result(ticks) : result
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    shouldContinue: () => calls.length < runs,
    calls,
    sleeps,
    ...overrides,
  }
}

describe('digestCommand --loop — a digest per interval, until killed (#62)', () => {
  it('runs the digest repeatedly and prints every one of them to stdout', async () => {
    const d = loopDeps({ runs: 3 })
    const result = await digestCommand(d)

    expect(result.exitCode).toBe(0)
    expect(d.calls).toHaveLength(3)
    // Three digests, three headings — the pane reads back as a narrative, not as one
    // digest that overwrote the last.
    const out = d.stdout.output()
    expect(out).toContain('digest 1:')
    expect(out).toContain('digest 2:')
    expect(out).toContain('digest 3:')
    expect(d.stderr.output()).toBe('')
  })

  it('waits the configured interval between digests, and does not wait after the last', async () => {
    const d = loopDeps({ runs: 3, interval: '30m' })
    await digestCommand(d)
    // 1800s in ms, twice: the first digest is immediate (you attach and see
    // something), and a loop told to stop does not sit out one more interval first.
    expect(d.sleeps).toEqual([1800000, 1800000])
  })

  it('shares the scheduler grammar, so every documented duration works here too', async () => {
    for (const [input, ms] of [
      ['90', 90000],
      ['45s', 45000],
      ['30m', 1800000],
      ['2h', 7200000],
      ['1d', 86400000],
    ]) {
      const d = loopDeps({ runs: 2, interval: input })
      await digestCommand(d)
      expect(d.sleeps, input).toEqual([ms])
    }
  })

  it('digests once and stops when it is told not to continue', async () => {
    // `shouldContinue` gates CONTINUING, not starting: a digest window that is killed
    // during its first digest still leaves that digest in the pane.
    const d = loopDeps({ runs: 1 })
    const result = await digestCommand(d)
    expect(d.calls).toHaveLength(1)
    expect(d.sleeps).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  it('forwards the same cwd and env to every digest it runs', async () => {
    const d = loopDeps({ runs: 3, cwd: '/elsewhere', env: { RALPH_DIGEST_MODEL: 'sonnet' } })
    await digestCommand(d)
    for (const call of d.calls) {
      expect(call.cwd).toBe('/elsewhere')
      expect(call.env).toEqual({ RALPH_DIGEST_MODEL: 'sonnet' })
    }
  })

  it('reports how many digests it produced', async () => {
    const d = loopDeps({ runs: 4 })
    const result = await digestCommand(d)
    expect(result.runs).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// AC#8. The digest is an accessory: a night of them is worth having, and not one of
// them is worth the loop's company. So no single failure may end the timer.
// ---------------------------------------------------------------------------

describe('digestCommand --loop — one bad digest never ends the loop (#62)', () => {
  it('keeps going after an engine that reports a failure', async () => {
    const d = loopDeps({
      runs: 3,
      result: (n) =>
        n === 2
          ? { status: 'failed', narrative: null, diagnostic: 'ralph digest: the agent exited 1' }
          : okResult(n),
    })
    const result = await digestCommand(d)

    expect(d.calls).toHaveLength(3)
    expect(result.exitCode).toBe(0)
    // The failure is on stderr, the two good digests are on stdout, and the timer
    // never skipped a beat.
    expect(d.stderr.output()).toContain('the agent exited 1')
    expect(d.stdout.output()).toContain('digest 1:')
    expect(d.stdout.output()).toContain('digest 3:')
    expect(d.sleeps).toEqual([1800000, 1800000])
  })

  it('keeps going after an engine that THROWS', async () => {
    const d = loopDeps({
      runs: 3,
      result: (n) => {
        if (n === 1) throw new Error('spawn ENOENT')
        return okResult(n)
      },
    })
    const result = await digestCommand(d)

    expect(d.calls).toHaveLength(3)
    expect(result.exitCode).toBe(0)
    expect(d.stderr.output()).toMatch(/digest/i)
    // A stack trace in a pane a human is watching is noise about Ralph, not news
    // about their run.
    expect(d.stderr.output()).not.toContain('at ')
    expect(d.stdout.output()).toContain('digest 2:')
  })

  it('survives a digest that fails EVERY time — still exit 0, one line each', async () => {
    const d = loopDeps({
      runs: 3,
      result: () => ({ status: 'no-run', narrative: null, diagnostic: 'ralph digest: no run recorded here yet' }),
    })
    const result = await digestCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.calls).toHaveLength(3)
    expect(d.stdout.output()).toBe('')
    expect(d.stderr.lines()).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// A timer with no usable interval is not a timer. It must not spin, and it must not
// take the exit-0 contract down with it either.
// ---------------------------------------------------------------------------

describe('digestCommand --loop — an interval it cannot honor (#62)', () => {
  it('refuses to loop on an unparseable interval, says why, and exits 0', async () => {
    const d = loopDeps({ interval: 'half an hour' })
    const result = await digestCommand(d)
    expect(result.exitCode).toBe(0)
    expect(d.calls).toHaveLength(0)
    expect(d.sleeps).toEqual([])
    expect(d.stdout.output()).toBe('')
    expect(d.stderr.lines()).toHaveLength(1)
    expect(d.stderr.output()).toContain('half an hour')
    expect(d.stderr.output()).toContain('30m')
  })

  it('refuses to loop with --loop and no --interval at all', async () => {
    // `null` is how commander hands over an option the user did not pass, and '' is
    // how a `RALPH_DIGEST_INTERVAL=""` would arrive if it ever got this far.
    for (const interval of [null, '', '   ']) {
      const d = loopDeps({ interval })
      const result = await digestCommand(d)
      expect(result.exitCode, String(interval)).toBe(0)
      expect(d.calls, String(interval)).toHaveLength(0)
      expect(d.stderr.lines(), String(interval)).toHaveLength(1)
    }
    // ...and with no interval in the call at all, rather than an explicit nothing.
    const bare = loopDeps({})
    delete bare.interval
    const result = await digestCommand(bare)
    expect(result.exitCode).toBe(0)
    expect(bare.calls).toHaveLength(0)
    expect(bare.stderr.lines()).toHaveLength(1)
  })

  it('asks for an --interval rather than reporting its own `null` back at the reader', async () => {
    // `ralph digest --loop` with nothing after it is the likeliest way anyone reaches
    // this line by hand, and "invalid interval: null" is a sentence about Ralph's
    // option parsing — the reader needs to be told what to type instead.
    const missing = [loopDeps({ interval: null }), loopDeps({ interval: '' }), loopDeps({ interval: '   ' })]
    const bare = loopDeps({})
    delete bare.interval
    missing.push(bare)

    for (const d of missing) {
      const result = await digestCommand(d)
      const said = d.stderr.output()
      expect(said, said).not.toMatch(/null|undefined/)
      expect(said, said).toContain('--interval')
      expect(said, said).toContain('30m')
      // Its own status, not the grammar's: nothing was supplied, so nothing was invalid.
      expect(result, said).toEqual({ exitCode: 0, status: 'no-interval', runs: 0 })
    }
  })

  it('refuses to loop on a zero interval instead of spinning on the model', async () => {
    // `--interval 0` parses (it is a duration of nothing), so the guard against a
    // busy loop has to be here. Zero is also how ralph.config.sh turns the digest
    // off (#60), which is exactly the value that would arrive by accident.
    for (const interval of ['0', '0m', '0h', '0d']) {
      const d = loopDeps({ interval })
      const result = await digestCommand(d)
      expect(result.exitCode, interval).toBe(0)
      expect(d.calls, interval).toHaveLength(0)
      expect(d.sleeps, interval).toEqual([])
      expect(d.stderr.lines(), interval).toHaveLength(1)
    }
  })

  it('refuses an interval no timer can wait, instead of digesting every millisecond', async () => {
    // The zero guard above, reached from the other end. setTimeout's delay is a signed
    // 32-bit millisecond count: hand it `25d` and node warns TimeoutOverflowWarning
    // and fires after ONE MILLISECOND — the same busy loop as `--interval 0`, except
    // this one spends a model call per tick. Reachable from the CLI and from a config
    // (`RALPH_DIGEST_INTERVAL=30d`).
    for (const interval of ['25d', '30d', '9999999999', String(Number.MAX_SAFE_INTEGER)]) {
      const d = loopDeps({ runs: 3, interval })
      const result = await digestCommand(d)
      expect(result, interval).toEqual({ exitCode: 0, status: 'invalid-interval', runs: 0 })
      expect(d.calls, interval).toHaveLength(0)
      expect(d.sleeps, interval).toEqual([])
      expect(d.stderr.lines(), interval).toHaveLength(1)
      expect(d.stderr.output(), interval).toContain(interval)
    }
  })

  it('still keeps the longest appointment a timer CAN keep', async () => {
    // The other side of that boundary: the refusal must not creep down into intervals
    // a clock can honor, and 24 days is the longest one it can.
    const d = loopDeps({ runs: 2, interval: '24d' })
    const result = await digestCommand(d)
    expect(d.sleeps).toEqual([2073600000])
    expect(result.runs).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// The one-shot path is the DEFAULT and is unchanged: no --loop, no timer, no clock
// consulted. Covered fully in digest.test.js; asserted here only where the new
// options could have leaked into it.
// ---------------------------------------------------------------------------

describe('digestCommand — one shot is still one shot (#62)', () => {
  it('runs exactly once and never sleeps without --loop', async () => {
    const d = loopDeps({ loop: false })
    const result = await digestCommand(d)
    expect(d.calls).toHaveLength(1)
    expect(d.sleeps).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(result.status).toBe('ok')
  })

  it('ignores an interval it was given without --loop', async () => {
    const d = loopDeps({ loop: false, interval: 'not-a-duration' })
    const result = await digestCommand(d)
    expect(d.calls).toHaveLength(1)
    expect(result.exitCode).toBe(0)
    expect(d.stderr.output()).toBe('')
  })

  it('does not pass its own options down to the engine', async () => {
    // `loop`, `interval`, `sleep` and `shouldContinue` belong to the command; the
    // engine takes cwd/env/stderr and its own collaborators. A leak here would be
    // an engine that starts taking launch decisions from CLI flags.
    const d = loopDeps({ loop: false })
    await digestCommand(d)
    const bag = d.calls[0]
    expect(bag.loop).toBeUndefined()
    expect(bag.interval).toBeUndefined()
    expect(bag.sleep).toBeUndefined()
    expect(bag.shouldContinue).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CLI registration. bin/ralph.js parses argv on import and bin/ is outside vitest's
// include globs, so the wiring is asserted from real `--help` invocations, exactly
// as digest.test.js does for the command itself.
// ---------------------------------------------------------------------------

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))
const cli = (...argv) => execa('node', [BIN, ...argv], { reject: false })

describe('ralph digest --loop — registered in the CLI (#62)', () => {
  it('documents --loop and --interval in `ralph digest --help`', async () => {
    const result = await cli('digest', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--loop')
    expect(result.stdout).toContain('--interval <duration>')
    expect(result.stderr).toBe('')
  })

  it('the --interval help names a duration a user can copy', async () => {
    const result = await cli('digest', '--help')
    const line = result.stdout.split('\n').find((l) => l.trim().startsWith('--interval'))
    expect(line).toMatch(/30m|2h|1d/)
  })

  it('rejects an unknown digest option, so a typo is not silently a one-shot', async () => {
    const result = await cli('digest', '--looop')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--looop')
  })
})
