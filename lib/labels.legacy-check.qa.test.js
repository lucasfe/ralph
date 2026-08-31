// #141 QA augmentation — findLegacyLabels against the answers `gh` can really give, and
// against an `exec` that misbehaves in every way the seam allows.
//
// The dev's specs in labels.test.js drive the check through thirteen cases — six against a `gh`
// that works, and seven inside an 'empty result on every failure' describe. What they do NOT do
// is push on the four places the implementation makes a silent judgement call:
//
// 1. WHAT COUNTS AS A LABEL. The parse pipeline is `JSON.parse` → `Array.isArray` →
//    `label && typeof label.name === 'string'` → `Set`. Every rung of that ladder discards
//    something, and the dev's specs exercise two of them (a non-array, an array of bare
//    strings). This file walks the whole ladder — an array of nulls, of numbers, of arrays, of
//    objects whose `name` is null / a number / an object, and a `{}` — plus the two shapes the
//    ladder must NOT discard: a `--json name` payload that carries extra fields, and duplicate
//    entries for one name (GitHub cannot produce those, an over-eager `--jq` or a merged page
//    can, and a duplicate must not become a duplicate WARNING).
//
// 2. WHAT COUNTS AS A MATCH. `Set.prototype.has` is exact and case-sensitive, so a retired name
//    wearing a capital letter is invisible to this check, and so is a label that merely CONTAINS
//    a retired name. Both behaviours are pinned below rather than argued for — see the comment
//    on the case test, which flags the question rather than answering it. GitHub's own label
//    uniqueness is case-INSENSITIVE, which is why the question exists at all.
//
// 3. WHETHER THE COMMAND IT PRINTS SURVIVES A SHELL. `migrationCommand` interpolates the
//    replacement label's description into single quotes with no escaping. That is safe today,
//    and safe only because no description in MANAGED_LABELS contains an apostrophe — measured,
//    not assumed. So the safety is a property of three strings a future reword can change
//    without ever touching this feature, and it is pinned here as its own assertion with a
//    demonstration that the assertion can fail.
//
// 4. WHETHER THE SEAM LEAKS. The `exec` is a parameter, which means every hostile shape a
//    caller can hand over is reachable: one that throws synchronously, one that rejects
//    despite `{ reject: false }`, one that is not async at all, one that is not a function, and
//    a call with no argument object. The contract is "empty on every failure, never a throw",
//    and a contract stated that broadly is worth testing that broadly.
//
// THE RETIRED SPELLINGS ARE COMPOSED FROM Object.keys(LEGACY_LABELS) AND NEVER TYPED, including
// the deliberately-miscased variant, which is built by upper-casing the first letter of each
// hyphen-separated part rather than written out. lib/labels.parity.test.js and
// lib/labels.rename.qa.test.js sweep every tracked file for those spellings and this file is
// not on test/helpers/legacy-label-sweep.js's three-file exemption list — and the sweep's
// matcher is case-INSENSITIVE, so typing the miscased variant out would be caught too — measured
// the hard way: the first draft of this header spelled it in prose and the matcher reported this
// file as an offender.

import { describe, expect, it } from 'vitest'
import { findLegacyLabels, LEGACY_LABELS, MANAGED_LABELS } from './labels.js'

// Straight off the mapping, in its order. Two entries today; every assertion below is written
// against the array rather than against the number, so a third retirement costs nothing here.
const RETIRED = Object.freeze(Object.keys(LEGACY_LABELS))

// `gh label list --json name` answers with objects, not bare names.
const listing = (...names) => JSON.stringify(names.map((name) => ({ name })))

// Records argv and options, and answers with whatever it was built from. `answer` may be a
// value (resolved as-is) or a function (CALLED for its raw return, so a synchronous throw, a
// rejection and a non-promise return are all reachable).
function makeExec(answer) {
  const calls = []
  const exec = (cmd, args, options) => {
    calls.push({ cmd, args, options, key: `${cmd} ${args.join(' ')}` })
    return typeof answer === 'function' ? answer(cmd, args, options) : answer
  }
  exec.calls = calls
  return exec
}

const ok = (stdout) => makeExec(Promise.resolve({ exitCode: 0, stdout, stderr: '' }))

describe('QA #141 — what findLegacyLabels accepts as a label listing', () => {
  it('discards every JSON value that is not an array', async () => {
    // Array.isArray is the gate. Six values, each of them legal JSON and none of them a
    // listing — `42` and `"a string"` in particular parse fine and would reach `.filter` as a
    // number and a string if the guard were `typeof parsed === 'object'`.
    for (const payload of ['{}', '"a string"', '42', 'true', 'null', '{"labels":[]}']) {
      expect(await findLegacyLabels({ exec: ok(payload) }), payload).toEqual([])
    }
  })

  it('discards every array ENTRY that cannot carry a name, without discarding the array', async () => {
    // The junk is mixed WITH a real hit on purpose. An implementation that bailed on the first
    // unusable entry — or that let one throw out of the map — would lose the retired label
    // that is sitting right there in the same payload, and the failure would be silent.
    const payload = JSON.stringify([
      null,
      42,
      'a bare string',
      [],
      {},
      { name: null },
      { name: 123 },
      { name: { value: RETIRED[0] } },
      { name: RETIRED[0] },
    ])
    const found = await findLegacyLabels({ exec: ok(payload) })
    expect(found.map((entry) => entry.legacy)).toEqual([RETIRED[0]])
  })

  it('reports a name that appears twice exactly once', async () => {
    // One retired label is one warning, however many times the listing mentions it. GitHub
    // cannot return a duplicate, but a `--jq` filter, a hand-built fixture or a caller that
    // concatenated two pages can, and three identical paragraphs of migration advice in a
    // preflight is a worse bug than the one being reported.
    const found = await findLegacyLabels({
      exec: ok(listing(RETIRED[0], RETIRED[0], RETIRED[0])),
    })
    expect(found).toHaveLength(1)
    expect(found[0].legacy).toBe(RETIRED[0])
  })

  it('reads `name` off entries that carry more fields than were asked for', async () => {
    // The argv requests one field, but nothing in the pipeline depends on that: a future
    // `--json name,color` (or a gh that starts padding its output) must not change the answer.
    const payload = JSON.stringify([
      { id: 'LA_1', name: RETIRED[0], color: 'FFA500', description: 'Ralph loop em andamento' },
    ])
    const found = await findLegacyLabels({ exec: ok(payload) })
    expect(found.map((entry) => entry.legacy)).toEqual([RETIRED[0]])
  })

  it('matches a whole name only — never a label that merely CONTAINS a retired one', async () => {
    // `Set.prototype.has`, not a substring scan. A board that archived its old label under a
    // decorated name has not kept the retired one, and telling a user to rename a label they
    // do not have is a migration command that fails for a reason nothing explains.
    const decorated = [`old-${RETIRED[0]}`, `${RETIRED[0]}-2`, `${RETIRED[0]}s`]
    expect(await findLegacyLabels({ exec: ok(listing(...decorated)) })).toEqual([])
  })

  it('is CASE-SENSITIVE, so a miscased retired label is invisible — pinned, not endorsed', async () => {
    // FLAGGED FOR REVIEW rather than asserted as correct. This test records what the code does
    // today; whether it is what the code SHOULD do is a judgement call a human owns.
    //
    // The facts, measured: `gh label list --json name` returns the name with the case the
    // label was created with, and the match is `Set.prototype.has`, so only the exact bytes of
    // the mapping key are found. GitHub's label uniqueness, on the other hand, is
    // case-insensitive — a repository cannot hold two labels differing only in case — which is
    // what makes a miscased retired label a real, if unlikely, state for a board to be in
    // (a human created it by hand, or renamed the one the April 2026 shell script created).
    //
    // The cost if it happens is the exact gap #141 exists to close, back again and now
    // silent: the issues carrying it are excluded by nothing and swept by nothing, and the
    // preflight says the board is clean.
    //
    // The variant is COMPOSED, never typed — see this file's header for why.
    const miscased = RETIRED[0]
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('-')
    expect(miscased).not.toBe(RETIRED[0])
    expect(await findLegacyLabels({ exec: ok(listing(miscased)) })).toEqual([])
    // ...and the exact spelling in the same listing IS found, so the test above is measuring
    // case-sensitivity and not a broken fixture.
    expect(
      (await findLegacyLabels({ exec: ok(listing(miscased, RETIRED[0])) })).map((e) => e.legacy),
    ).toEqual([RETIRED[0]])
  })

  it('survives stdout that is a Buffer, or that carries a byte-order mark', async () => {
    // Two shapes a real `exec` can produce that a fixture never does. execa returns a Buffer
    // when it is configured with a null encoding, and `String(buffer)` is what makes that
    // work; a BOM survives into stdout from a Windows-side gh and is stripped by `.trim()`,
    // because U+FEFF is whitespace to `String.prototype.trim` but a syntax error to
    // `JSON.parse`. Both are measured here rather than reasoned about — neither is guarded
    // deliberately, and this pins the behaviour the current code happens to have.
    const json = listing(RETIRED[0])
    for (const stdout of [Buffer.from(json), `\uFEFF${json}`]) {
      const found = await findLegacyLabels({ exec: ok(stdout) })
      expect(found.map((entry) => entry.legacy), String(stdout)).toEqual([RETIRED[0]])
    }
  })

  it('treats a result with no stdout key, and a non-zero-ish exit code, as no answer', async () => {
    // `result.stdout ?? ''` and `result.exitCode !== 0` are both strict. A result object that
    // reports success without carrying output yields a clean board rather than a TypeError,
    // and an exit code that is absent, or a STRING, is not zero.
    expect(await findLegacyLabels({ exec: makeExec({ exitCode: 0 }) })).toEqual([])
    expect(await findLegacyLabels({ exec: makeExec({ stdout: listing(RETIRED[0]) }) })).toEqual([])
    expect(
      await findLegacyLabels({ exec: makeExec({ exitCode: '0', stdout: listing(RETIRED[0]) }) }),
    ).toEqual([])
  })
})

describe('QA #141 — the exec seam, abused', () => {
  it('answers empty for an exec that throws SYNCHRONOUSLY', async () => {
    // Distinct from the dev's ENOENT case, which throws from inside an async function and so
    // arrives as a rejection. A synchronous throw escapes at the call expression itself, and
    // only survives because the `try` wraps the call and not just the `await`.
    const exec = makeExec(() => {
      throw new Error('spawn gh EACCES')
    })
    await expect(findLegacyLabels({ exec })).resolves.toEqual([])
  })

  it('answers empty for an exec that REJECTS despite `{ reject: false }`', async () => {
    // The option is a request, not a guarantee — it is honoured by execa, and this module hands
    // it to whatever it was given. A caller whose exec ignores it (a wrapper, a mock, a future
    // replacement) must not turn a diagnostic into an unhandled rejection in a preflight.
    const exec = makeExec(() =>
      Promise.reject(Object.assign(new Error('Command failed with exit code 1'), { exitCode: 1 })),
    )
    await expect(findLegacyLabels({ exec })).resolves.toEqual([])
  })

  it('answers empty for an exec that resolves to a primitive, or to nothing', async () => {
    for (const answer of [undefined, null, 0, '', 'ok', false]) {
      expect(await findLegacyLabels({ exec: makeExec(answer) }), String(answer)).toEqual([])
    }
  })

  it('works with an exec that is NOT async — the seam is `await`, not `Promise`', async () => {
    // Nothing in the contract requires a promise, and a synchronous test double is the most
    // likely thing a future caller hands over by accident. `await` on a plain object is the
    // object, so this works; pinned so a refactor to `.then(…)` or `Promise.resolve(exec(…))
    // .catch` cannot quietly narrow what an acceptable exec is.
    const exec = makeExec(() => ({ exitCode: 0, stdout: listing(RETIRED[0]), stderr: '' }))
    expect((await findLegacyLabels({ exec })).map((entry) => entry.legacy)).toEqual([RETIRED[0]])
  })

  it('answers empty for every non-function exec, and for no argument at all', async () => {
    for (const exec of [null, undefined, 'gh', 42, {}, [], Symbol('exec')]) {
      expect(await findLegacyLabels({ exec }), String(exec)).toEqual([])
    }
    expect(await findLegacyLabels({})).toEqual([])
    expect(await findLegacyLabels()).toEqual([])
  })

  it('REJECTS rather than throwing synchronously when handed a null argument', async () => {
    // The one input that does not produce an empty list: `{ exec } = {}` defaults only for
    // `undefined`, so destructuring `null` is a TypeError. Pinned as the behaviour it actually
    // has rather than as the behaviour it should have — no caller passes null, `ralph start`
    // passes `{ exec }` — and pinned as a REJECTION specifically, because that is the half
    // that matters: a synchronous throw from parameter binding would escape a caller that only
    // guards the await, and an async function's binding errors do not do that.
    let returned
    expect(() => {
      returned = findLegacyLabels(null)
    }).not.toThrow()
    expect(returned).toBeInstanceOf(Promise)
    await expect(returned).rejects.toBeInstanceOf(TypeError)
  })

  it('spends exactly ONE call however many retired names the board carries', async () => {
    // One round trip, not one per mapping entry. The argv asks for the whole label list, so a
    // per-name implementation would be N network calls for the same answer.
    const exec = ok(listing(...RETIRED))
    const found = await findLegacyLabels({ exec })
    expect(found).toHaveLength(RETIRED.length)
    expect(exec.calls).toHaveLength(1)
  })

  it('hands over a COPY of its argv — a caller that mutates it cannot poison the next run', async () => {
    // LEGACY_LIST_ARGS is frozen and spread at the call site, and the freeze alone does not
    // buy this: a frozen source array passed by reference would hand every caller the same
    // object, and `Object.freeze` would stop a write to the module's array while doing nothing
    // about a caller that reversed a copy in place. Measured as the consequence — mutate what
    // arrives, call again, and the second argv is unchanged.
    const exec = ok(listing(RETIRED[0]))
    await findLegacyLabels({ exec })
    const first = [...exec.calls[0].args]
    exec.calls[0].args.length = 0
    exec.calls[0].args.push('label', 'delete', '--yes')
    await findLegacyLabels({ exec })
    expect(exec.calls[1].args).toEqual(first)
  })

  it('re-asks on every call — no memoized answer across a changing board', async () => {
    // A board can be migrated BETWEEN two calls in one process (`ralph cycle` is long-lived),
    // and a check that cached its first answer would keep printing a fixed warning. Two calls,
    // two different answers, two exec calls.
    const answers = [
      { exitCode: 0, stdout: listing(RETIRED[0]), stderr: '' },
      { exitCode: 0, stdout: listing('in-progress'), stderr: '' },
    ]
    const exec = makeExec(() => Promise.resolve(answers.shift()))
    expect((await findLegacyLabels({ exec })).map((e) => e.legacy)).toEqual([RETIRED[0]])
    expect(await findLegacyLabels({ exec })).toEqual([])
    expect(exec.calls).toHaveLength(2)
  })
})

describe('QA #141 — the order of the report, and the shell-safety of the command in it', () => {
  it('reports in the MAPPING\u2019s order for every order the board lists them in', async () => {
    // Asserted against Object.keys(LEGACY_LABELS) rather than against a literal pair, so the
    // property under test is "the mapping decides" and not "these two words in this sequence".
    // Driven through both permutations plus a listing padded with unrelated labels, because a
    // single reversed fixture agrees with an implementation that simply reverses.
    const permutations = [
      [...RETIRED],
      [...RETIRED].reverse(),
      ['bug', RETIRED[RETIRED.length - 1], 'in-progress', ...RETIRED.slice(0, -1), 'question'],
    ]
    for (const names of permutations) {
      const found = await findLegacyLabels({ exec: ok(listing(...names)) })
      expect(found.map((entry) => entry.legacy), names.join(',')).toEqual([...RETIRED])
    }
  })

  it('names the mapping\u2019s replacement as the destination, for every entry', async () => {
    const found = await findLegacyLabels({ exec: ok(listing(...RETIRED)) })
    expect(found.map((entry) => entry.current)).toEqual(Object.values(LEGACY_LABELS))
    for (const entry of found) {
      expect(entry.current, entry.legacy).toBe(LEGACY_LABELS[entry.legacy])
    }
  })

  it('emits one single line per label, with no shell control bytes in it', async () => {
    // The string is printed for a human to PASTE, so anything a shell would act on is a
    // hazard the moment a label name or a description acquires one. Nothing composed today
    // carries any of these; the assertion is here so the day one does is the day this goes red.
    for (const entry of await findLegacyLabels({ exec: ok(listing(...RETIRED)) })) {
      expect(entry.command, entry.legacy).not.toMatch(/[\n\r]/)
      expect(entry.command, entry.legacy).not.toMatch(/[`;&|<>$\\]/)
      expect(entry.command.startsWith('gh label edit '), entry.command).toBe(true)
    }
  })

  it('carries no MANAGED_LABELS description that would break its own single quoting', async () => {
    // THE COMPOSITION IS SAFE BY ACCIDENT, and this is where that is written down.
    // migrationCommand interpolates the replacement's description into `--description '<…>'`
    // with no escaping at all, so its safety is entirely a property of three strings that live
    // well above it in the same file and have nothing to do with this feature. Measured: none of
    // the three descriptions in MANAGED_LABELS today contains an apostrophe, a backslash or a
    // backtick.
    // A reword to, say, "Ralph's loop is in progress" is a one-word edit that silently emits a
    // command a shell splits in the middle.
    for (const spec of MANAGED_LABELS) {
      expect(spec.description, spec.name).not.toMatch(/['\\`]/)
    }
  })

  it('emits a command a shell splits into the argv it looks like', async () => {
    // The assertion the one above is a proxy for, made directly: tokenize the emitted line the
    // way a POSIX shell would and check the description arrives as ONE argument. This is what
    // an unescaped apostrophe actually costs — not a syntax error, but `gh label edit` receiving
    // a truncated description and a stray positional it will refuse.
    const found = await findLegacyLabels({ exec: ok(listing(...RETIRED)) })
    expect(found).toHaveLength(RETIRED.length)
    for (const entry of found) {
      const spec = MANAGED_LABELS.find((label) => label.name === entry.current)
      expect(tokenize(entry.command), entry.command).toEqual([
        'gh',
        'label',
        'edit',
        entry.legacy,
        '--name',
        entry.current,
        '--description',
        spec.description,
      ])
    }
  })

  it('...and the tokenizer above can see the breakage it is watching for', async () => {
    // A guard that reports nothing is worth nothing until it is shown reporting something.
    // MANAGED_LABELS is frozen, so the hostile description cannot be injected into the real
    // composition; the same string shape is built by hand instead, exactly as migrationCommand
    // would build it, and the tokenizer disagrees with it.
    const hostile = `gh label edit x --name y --description 'Ralph's loop in progress'`
    expect(tokenize(hostile)).not.toEqual([
      'gh',
      'label',
      'edit',
      'x',
      '--name',
      'y',
      '--description',
      "Ralph's loop in progress",
    ])
    // ...and specifically it splits the description, which is the failure mode.
    expect(tokenize(hostile).length).toBeGreaterThan(8)
  })
})

// A POSIX-ish argv splitter: whitespace separates, single quotes group and are literal inside.
// Enough for the one command shape under test, and deliberately not a shell — it exists to show
// that the emitted line means what it looks like, and it is demonstrated failing on a broken
// line in the test directly above.
function tokenize(line) {
  const tokens = []
  let current = ''
  let started = false
  let quoted = false
  for (const char of line) {
    if (char === "'") {
      quoted = !quoted
      started = true
    } else if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) tokens.push(current)
  return tokens
}
