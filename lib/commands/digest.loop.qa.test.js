import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execa } from 'execa'
import { digestCommand } from './digest.js'
// `setTimeout`'s ceiling, from the module that owns it and enforces it. Imported and
// not restated: a second copy of the exact number this change exists to de-duplicate
// could drift from the one the code checks against, and the test would still pass.
import { MAX_TIMER_MS } from '../duration.js'

// QA augmentation for #62's `--loop`. The dev's digest.loop.test.js proves the
// timer's shape — N digests, N-1 sleeps, one bad tick never ends it. This file goes
// after the parts of a loop that only hurt in production:
//
//   - the ORDER of digest / shouldContinue / sleep, read off one interleaved trace
//     rather than three separate counters, because "did it sleep after the last
//     one?" and "was the kill signal noticed before or after the model call?" are
//     questions about sequence;
//   - the exit-0-always contract under engine results nobody designed for
//     (undefined, null, a string, a thenable, a synchronous throw);
//   - CHANNEL purity across ticks, which is the promise `ralph digest --loop |
//     pbcopy` depends on: prose on stdout, every diagnostic on stderr, forever;
//   - an interval that PARSES and is still not survivable — the sibling of the
//     zero-interval guard, and the one that costs money rather than a refusal.
//
// Nothing here waits, spawns an agent or opens a network socket. The two CLI cases
// at the bottom run the real binary, and they are the two that refuse BEFORE the
// first model call — verified by the fact that they return instantly with nothing on
// stdout.

const NARRATIVE = 'The dev is in the red phase on #062.\nmain is 3 commits ahead.'

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

// Same bounded-clock harness as the dev's, plus ONE timeline that records the
// digest, the kill check and the sleep in the order they actually happened.
const loopDeps = ({ runs = 3, result = okResult, interval = '30m', ...overrides } = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const calls = []
  const sleeps = []
  const trace = []
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
      trace.push('digest')
      ticks += 1
      return typeof result === 'function' ? result(ticks) : result
    },
    sleep: async (ms) => {
      sleeps.push(ms)
      trace.push(`sleep:${ms}`)
    },
    shouldContinue: () => {
      trace.push('alive?')
      return calls.length < runs
    },
    calls,
    sleeps,
    trace,
    ...overrides,
  }
}

describe('QA: digest --loop — the order of digest, kill check and sleep (#62)', () => {
  it('digests, then asks whether to continue, then sleeps — never the other way round', async () => {
    const d = loopDeps({ runs: 3, interval: '30m' })
    await digestCommand(d)
    // Read as a sentence: narrate, check we are still wanted, wait. A `sleep` before
    // the first digest would mean nothing in the pane for half an hour after
    // attaching; an `alive?` before the first digest would mean a window killed
    // mid-startup printing nothing at all.
    expect(d.trace).toEqual([
      'digest',
      'alive?',
      'sleep:1800000',
      'digest',
      'alive?',
      'sleep:1800000',
      'digest',
      'alive?',
    ])
  })

  it('never consults the kill check before the first digest has been printed', async () => {
    // AC#1 says the loop prints each digest; the FIRST one is the one a human is
    // waiting for when they attach. `shouldContinue` gates continuing, not starting.
    let asked = 0
    const d = loopDeps({
      runs: 1,
      shouldContinue: () => {
        asked += 1
        return false
      },
      result: () => {
        expect(asked, 'the kill check ran before the first digest').toBe(0)
        return okResult(1)
      },
    })
    const result = await digestCommand(d)
    expect(d.calls).toHaveLength(1)
    expect(asked).toBe(1)
    expect(d.stdout.output()).toContain('digest 1:')
    expect(result.runs).toBe(1)
  })

  it('produces exactly ONE digest when told to stop immediately — not zero', async () => {
    // Pinning which side of the boundary this falls on: a pane that is killed during
    // its first digest still leaves that digest behind, and a `shouldContinue` that is
    // false from the start is the same shape.
    const d = loopDeps({ shouldContinue: () => false })
    const result = await digestCommand(d)
    expect(d.calls).toHaveLength(1)
    expect(d.sleeps).toEqual([])
    expect(result).toEqual({ exitCode: 0, status: 'stopped', runs: 1 })
  })

  it('reads any falsy answer as "stop" and any truthy one as "keep going"', async () => {
    // `shouldContinue` is a predicate an embedder writes; a function that forgets to
    // return must stop the loop rather than spin it forever.
    for (const answer of [undefined, null, 0, '', NaN, false]) {
      const d = loopDeps({ shouldContinue: () => answer })
      await digestCommand(d)
      expect(d.calls, String(answer)).toHaveLength(1)
    }
    let n = 0
    const d = loopDeps({ shouldContinue: () => (n++ < 2 ? 'yes' : 0) })
    await digestCommand(d)
    expect(d.calls).toHaveLength(3)
  })

  it('asks exactly once per digest, however many digests there are', async () => {
    const d = loopDeps({ runs: 5 })
    const result = await digestCommand(d)
    expect(d.trace.filter((t) => t === 'alive?')).toHaveLength(5)
    expect(d.trace.filter((t) => t === 'digest')).toHaveLength(5)
    expect(result.runs).toBe(5)
  })

  it('sleeps the SAME interval every time — no drift, no backoff, no jitter', async () => {
    // A digest window is read as "every half hour". A loop that quietly backed off
    // would leave a long night with three entries and look like a crash.
    const d = loopDeps({ runs: 6, interval: '45s' })
    await digestCommand(d)
    expect(d.sleeps).toEqual([45000, 45000, 45000, 45000, 45000])
  })

  it('accepts an interval that arrives with the whitespace a config file leaves on it', async () => {
    // `RALPH_DIGEST_INTERVAL="  30m "` reaches the window through a shell word and an
    // argv element, and the shared grammar trims. Asserted here because the value is
    // read from a file, not typed.
    for (const interval of ['  30m  ', '\t30m\n', '30 m', '30\tm']) {
      const d = loopDeps({ runs: 2, interval })
      await digestCommand(d)
      expect(d.sleeps, JSON.stringify(interval)).toEqual([1800000])
    }
  })

  it('tolerates a synchronous clock — a sleep that returns no promise still advances', async () => {
    const d = loopDeps({ runs: 3, sleep: () => undefined })
    const result = await digestCommand(d)
    expect(d.calls).toHaveLength(3)
    expect(result.exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The exit-0 contract, tick by tick. A digest is an accessory: it explains the run,
// it never changes it. So NOTHING an engine can return or throw may end the loop or
// the process badly.
// ---------------------------------------------------------------------------

describe('QA: digest --loop — exit 0 whatever the engine does (#62)', () => {
  const SHAPES = [
    ['undefined', () => undefined],
    ['null', () => null],
    ['an empty object', () => ({})],
    ['a string', () => 'a digest, allegedly'],
    ['a number', () => 42],
    ['an empty narrative', () => ({ status: 'ok', narrative: '', diagnostic: null })],
    ['narrative and diagnostic both null', () => ({ status: 'ok', narrative: null, diagnostic: null })],
    ['a rejected promise', () => Promise.reject(new Error('spawn ENOENT'))],
    [
      'a synchronous throw',
      () => {
        throw new Error('spawn ENOENT')
      },
    ],
    ['a thrown string', () => {
      throw 'not even an error'
    }],
    ['a thenable that rejects', () => ({ then: (_ok, no) => no(new Error('nope')) })],
  ]

  it.each(SHAPES)('keeps looping and exits 0 when the engine returns %s', async (_label, result) => {
    const d = loopDeps({ runs: 3, result })
    const outcome = await digestCommand(d)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.status).toBe('stopped')
    // Every tick was attempted, and the timer kept its appointments.
    expect(d.calls).toHaveLength(3)
    expect(d.sleeps).toEqual([1800000, 1800000])
    // One line of explanation per tick, at most — never a stack trace.
    expect(d.stderr.output()).not.toContain('at ')
    expect(d.stderr.output()).not.toContain('.js:')
  })

  it('treats a synchronous throw exactly like a rejected promise', async () => {
    // The engine is called through `await run(...)`; a sync throw and a rejection must
    // not produce two different diagnostics for one problem.
    const sync = loopDeps({
      runs: 2,
      result: () => {
        throw new Error('spawn ENOENT')
      },
    })
    const async_ = loopDeps({ runs: 2, result: () => Promise.reject(new Error('spawn ENOENT')) })
    await digestCommand(sync)
    await digestCommand(async_)
    expect(sync.stderr.output()).toBe(async_.stderr.output())
    expect(sync.stdout.output()).toBe(async_.stdout.output())
  })

  it('counts the failures in `runs` — the number is attempts, not successes', async () => {
    // What the field needs from this number is "did the timer keep firing", which a
    // count of successes would answer wrongly for a night where the agent was down.
    const d = loopDeps({ runs: 4, result: () => undefined })
    const result = await digestCommand(d)
    expect(result.runs).toBe(4)
    expect(d.calls).toHaveLength(4)
  })

  it('a first tick that throws does not stop the second from being tried', async () => {
    // The likeliest real failure: the window opens before the agent is authenticated,
    // and the first digest of the night is the one that dies.
    const d = loopDeps({
      runs: 3,
      result: (n) => {
        if (n === 1) throw new Error('not logged in')
        return okResult(n)
      },
    })
    await digestCommand(d)
    expect(d.stdout.output()).toContain('digest 2:')
    expect(d.stdout.output()).toContain('digest 3:')
    expect(d.trace[0]).toBe('digest')
    expect(d.trace[1]).toBe('alive?')
    expect(d.trace[2]).toBe('sleep:1800000')
  })

  it('never leaks its own options into the engine bag, on the LOOP path too', async () => {
    // The dev pins this for the one-shot path. The loop builds the bag in a different
    // place, so it can drift on its own — and an engine taking decisions from `loop`
    // or `interval` would be a CLI flag reaching into the model call.
    const d = loopDeps({ runs: 3 })
    await digestCommand(d)
    for (const bag of d.calls) {
      expect(bag.loop).toBeUndefined()
      expect(bag.interval).toBeUndefined()
      expect(bag.sleep).toBeUndefined()
      expect(bag.shouldContinue).toBeUndefined()
      // stdout is the COMMAND's channel: the engine reports through its return value
      // and writes diagnostics to stderr, so handing it the narrative stream would
      // let it print around the router.
      expect(bag.stdout).toBeUndefined()
      expect(bag.cwd).toBe('/repo')
      expect(bag.stderr).toBe(d.stderr)
    }
  })
})

// ---------------------------------------------------------------------------
// `ralph digest --loop | pbcopy` — the reason the two channels exist. Over one tick
// it is easy; the risk is a loop that eventually writes a warning, a separator or a
// tick counter into the prose.
// ---------------------------------------------------------------------------

describe('QA: digest --loop — stdout stays prose, across every tick (#62)', () => {
  it('writes NOTHING to stdout that a one-shot run would not have written', async () => {
    // Parity by construction: three one-shot digests, then one loop of three, same
    // engine answers. Byte-identical or the loop has grown a voice of its own.
    const oneShots = makeStream()
    for (const n of [1, 2, 3]) {
      const d = loopDeps({ loop: false, result: () => okResult(n), stdout: oneShots })
      await digestCommand(d)
    }
    const looped = loopDeps({ runs: 3 })
    await digestCommand(looped)
    expect(looped.stdout.output()).toBe(oneShots.output())
  })

  it('keeps stdout EMPTY through a night where every digest failed', async () => {
    const d = loopDeps({
      runs: 5,
      result: (n) =>
        n % 2 ? { status: 'failed', narrative: null, diagnostic: 'the agent exited 1' } : undefined,
    })
    await digestCommand(d)
    expect(d.stdout.output()).toBe('')
    // ...and said something about every one of them, once each.
    expect(d.stderr.lines()).toHaveLength(5)
  })

  it('never mixes a diagnostic into the prose, even on the ticks that half-worked', async () => {
    // A digest can be printed AND have failed to be recorded; the reader deserves
    // both facts, on the two different channels.
    const d = loopDeps({
      runs: 3,
      result: (n) => ({ ...okResult(n), diagnostic: 'could not append to .ralph/digest.log' }),
    })
    await digestCommand(d)
    expect(d.stdout.output()).not.toContain('could not append')
    expect(d.stderr.output()).toContain('could not append')
    expect(d.stdout.output()).not.toMatch(/ralph digest:/)
    for (const line of d.stderr.lines()) {
      expect(line).not.toContain('\n')
    }
  })

  it('a refusal to loop says its one line on stderr and prints nothing at all', async () => {
    // The refusal path is the one a `> notes.md` would notice: a file containing a
    // complaint instead of prose.
    // Two refusals, two statuses: an interval nobody supplied is not an interval that
    // failed the grammar, and a caller reading `status` has to be able to tell them
    // apart — the first is answered by typing `--interval 30m`, the second by fixing
    // what was typed.
    for (const [interval, status] of [
      [null, 'no-interval'],
      ['', 'no-interval'],
      ['   ', 'no-interval'],
      ['0', 'invalid-interval'],
      ['0m', 'invalid-interval'],
      ['half an hour', 'invalid-interval'],
      ['1.5h', 'invalid-interval'],
    ]) {
      const d = loopDeps({ interval })
      const result = await digestCommand(d)
      expect(d.stdout.output(), String(interval)).toBe('')
      expect(d.stderr.lines(), String(interval)).toHaveLength(1)
      expect(result, String(interval)).toEqual({ exitCode: 0, status, runs: 0 })
    }
  })

  it('refusing costs no model call, no clock and no kill check', async () => {
    // The guard is ahead of the first digest on purpose. Nothing downstream of it may
    // run — a refusal that still consulted the clock would be a loop with one tick.
    const d = loopDeps({ interval: 'nope' })
    await digestCommand(d)
    expect(d.calls).toEqual([])
    expect(d.sleeps).toEqual([])
    expect(d.trace).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The interval that parses and still cannot be honored. `0` was guarded because it
// would spin; this is the same failure mode approached from the other end, and it is
// the one that spends money rather than refusing to.
// ---------------------------------------------------------------------------

describe('QA: digest --loop — an interval no timer can keep (#62)', () => {
  it.each([
    ['25d', '25d'],
    ['30d', '30d'],
    ['9999999999 seconds', '9999999999'],
    ['MAX_SAFE_INTEGER seconds', String(Number.MAX_SAFE_INTEGER)],
  ])('refuses %s, or asks for a delay a real clock can honor', async (_label, interval) => {
    // `setTimeout` is a 32-bit signed millisecond count: hand it more than
    // 2_147_483_647 and node warns TimeoutOverflowWarning and fires after ONE
    // MILLISECOND instead. So the real `defaultSleep` turns any interval over ~24.8
    // days into no interval at all — a window calling a paid model as fast as it can
    // answer, which is precisely what the zero-interval guard exists to prevent.
    //
    // Either answer is fine: refuse it like a zero, or clamp it to something a clock
    // can keep. What must not happen is a request for a delay that silently becomes
    // 1ms.
    const d = loopDeps({ runs: 3, interval })
    const result = await digestCommand(d)

    const refused = result.status === 'invalid-interval'
    const honorable = d.sleeps.every((ms) => ms > 0 && ms <= MAX_TIMER_MS)
    expect(
      refused || honorable,
      `--interval ${interval} asked to sleep ${d.sleeps[0]}ms; setTimeout caps at ${MAX_TIMER_MS}ms and fires after 1ms beyond it, so this is a digest per millisecond`,
    ).toBe(true)
    // Whichever way it goes, the command still exits 0.
    expect(result.exitCode).toBe(0)
  })

  it('honors the documented durations, which are all well inside the clock', async () => {
    // The other side of the same boundary, so the guard above can never be "fixed" by
    // rejecting the values the config template advertises.
    for (const [interval, ms] of [['60', 60000], ['30m', 1800000], ['2h', 7200000], ['1d', 86400000]]) {
      const d = loopDeps({ runs: 2, interval })
      const result = await digestCommand(d)
      expect(d.sleeps, interval).toEqual([ms])
      expect(ms, interval).toBeLessThanOrEqual(MAX_TIMER_MS)
      expect(result.runs, interval).toBe(2)
    }
  })
})

// ---------------------------------------------------------------------------
// The real binary, on the two paths that refuse BEFORE any model call. Both return
// immediately and write nothing to stdout, which is also the proof that no agent was
// spawned.
// ---------------------------------------------------------------------------

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))
// A directory with no .ralph and no git: even if a refusal ever stopped refusing,
// there is nothing here to narrate and nothing to write to.
const cli = (...argv) => execa('node', [BIN, ...argv], { reject: false, cwd: tmpdir() })

describe('QA: ralph digest --loop — the real CLI refuses cleanly (#62)', () => {
  it.each([
    ['--loop with no --interval', ['digest', '--loop']],
    ['--loop --interval 0m', ['digest', '--loop', '--interval', '0m']],
    ['--loop --interval 0', ['digest', '--loop', '--interval', '0']],
    ['--loop --interval 0.5h', ['digest', '--loop', '--interval', '0.5h']],
    ['--loop --interval "half an hour"', ['digest', '--loop', '--interval', 'half an hour']],
  ])('%s: exit 0, one line on stderr, an empty stdout', async (_label, argv) => {
    const result = await cli(...argv)
    // Exit 0 because a digest that cannot run is not a broken run — a watchdog or a
    // `&&` chain must not read it as one.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr.split('\n').filter(Boolean)).toHaveLength(1)
    expect(result.stderr).toContain('ralph digest:')
    expect(result.stderr).not.toContain('at ')
    // No 'null'/'undefined' reported back at the reader, and nothing about a stack.
    expect(result.stderr).not.toMatch(/\bnull\b|\bundefined\b/)
  })

  it('takes the flags in either order, so neither is positional', async () => {
    const a = await cli('digest', '--loop', '--interval', 'bogus')
    const b = await cli('digest', '--interval', 'bogus', '--loop')
    expect(a.exitCode).toBe(0)
    expect(b.stderr).toBe(a.stderr)
  })

  it('rejects --interval with no value instead of looping on nothing', async () => {
    const result = await cli('digest', '--loop', '--interval')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/argument|option/i)
  })
})

// ---------------------------------------------------------------------------
// Re-attack on the fix for the overflow above (lib/duration.js parseTimerDuration).
// The four tests in "an interval no timer can keep" now pass, and they would also pass
// if the loop had CLAMPED the delay instead of refusing it. These pin which of the two
// actually shipped, and where the boundary sits — because `ralph start` validates with
// the same function, and a clamp on one side with a refusal on the other is a window
// opened for an interval the loop inside it will not run.
// ---------------------------------------------------------------------------

describe('QA: digest --loop — the ceiling is a REFUSAL, and it costs nothing (#62 fix)', () => {
  it.each([
    ['25d', '25d'],
    ['30d', '30d'],
    ['2147484 seconds — one second past the ceiling', '2147484'],
    ['9999999999 seconds', '9999999999'],
    ['MAX_SAFE_INTEGER seconds', String(Number.MAX_SAFE_INTEGER)],
  ])('refuses %s before it touches the clock or the model', async (_label, interval) => {
    const d = loopDeps({ runs: 3, interval })
    const result = await digestCommand(d)
    expect(result).toEqual({ exitCode: 0, status: 'invalid-interval', runs: 0 })
    // Nothing happened: no model call, no kill check, no sleep. The refusal is the
    // whole run, which is what makes it safe to reach from an unattended window.
    expect(d.trace).toEqual([])
    expect(d.stdout.output()).toBe('')
    // One line, and it names the limit rather than just saying no.
    expect(d.stderr.lines()).toEqual([
      `ralph digest: not looping — an interval of ${interval} is longer than a timer can wait (the longest is 24d)`,
    ])
  })

  it('draws the line at the last delay a timer can hold, not a round number', async () => {
    // Collected, because a fencepost error here is a one-second window between "runs
    // every 24 days" and "runs a thousand times a second".
    const rows = []
    for (const interval of ['24d', '2147483', '2147484', '25d']) {
      const d = loopDeps({ runs: 1, interval })
      const result = await digestCommand(d)
      rows.push([interval, result.status, d.sleeps])
    }
    expect(rows).toEqual([
      ['24d', 'stopped', []], // runs=1 → stops before the first sleep
      ['2147483', 'stopped', []],
      ['2147484', 'invalid-interval', []],
      ['25d', 'invalid-interval', []],
    ])

    // …and the delay it actually asks a clock for, at the boundary, is one the clock
    // can keep. (runs=2 so the loop reaches its sleep.)
    for (const [interval, ms] of [
      ['24d', 2073600000],
      ['2147483', 2147483000],
    ]) {
      const d = loopDeps({ runs: 2, interval })
      await digestCommand(d)
      expect(d.sleeps, interval).toEqual([ms])
      expect(ms).toBeLessThanOrEqual(MAX_TIMER_MS)
    }
  })

  it('still refuses a zero, and the reader now gets a sentence rather than a symbol', async () => {
    // The wording of this refusal moved into the shared parser with the fix. Pinned
    // because it is what a reader who just got no digest actually sees, and because
    // `ralph start`'s warning is built from the same bytes.
    const rows = []
    for (const interval of ['0', '0m', '0d', ' 0 ']) {
      const d = loopDeps({ runs: 3, interval })
      const result = await digestCommand(d)
      rows.push([interval, result.status, d.stderr.lines()])
    }
    expect(rows).toEqual(
      ['0', '0m', '0d', ' 0 '].map((i) => [
        i,
        'invalid-interval',
        [`ralph digest: not looping — an interval of ${i} is not an interval (expected e.g. 60, 30m, 2h, 1d)`],
      ]),
    )
  })

  it('keeps the absent-interval sentence, which is about the option and not the grammar', async () => {
    // The one refusal that must NOT come from the parser: `--loop` with nothing after
    // it needs to say what to type, not report `invalid interval: null`. And it reports
    // its own status for the same reason the sentence is its own — `invalid-interval`
    // would label a value nobody supplied as a value that failed the grammar.
    for (const interval of [null, undefined, '', '   ']) {
      // Assigned after the harness builds, because `undefined` is exactly the case a
      // default parameter would swallow — and it is the case a bare `--loop` produces.
      const d = { ...loopDeps({ runs: 3 }), interval }
      const result = await digestCommand(d)
      expect(result).toEqual({ exitCode: 0, status: 'no-interval', runs: 0 })
      expect(d.stderr.lines()).toEqual([
        'ralph digest: not looping — --loop needs an interval (e.g. --interval 30m)',
      ])
    }
  })

  it('refuses an over-long interval through the real CLI too, on stderr and exit 0', async () => {
    for (const interval of ['30d', '25d', '2147484']) {
      const result = await cli('digest', '--loop', '--interval', interval)
      expect(result.exitCode, interval).toBe(0)
      expect(result.stdout, interval).toBe('')
      expect(result.stderr.split('\n').filter(Boolean), interval).toHaveLength(1)
      expect(result.stderr, interval).toContain('longer than a timer can wait')
      expect(result.stderr, interval).toContain('24d')
      expect(result.stderr, interval).not.toContain('at ')
    }
  })
})
