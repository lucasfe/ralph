import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAgentInvocation, emitShellAssignments } from './agent-invocation.js'
import { agentSpec } from './agent-registry.js'

// QA augmentation for #221's codex writable-root flag. lib/agent-invocation.test.js pins the
// argv SHAPE (position, omission when PROJECT_ROOT is blank, a `"` in the path, the Claude
// argv left alone) by inspecting the returned array. What it cannot see from there is the
// only place that array is ever used:
//
//     sh="$(node "$RALPH_PKG_DIR/lib/agent-invocation.js" 2>"$_err")"
//     eval "$sh"
//     …
//     node "$prompt_script" \
//       | ( cd "$agent_cwd" && exec "$RALPH_AGENT_CLI" "${RALPH_AGENT_ARGS[@]}" ) …
//
// — templates/ralph.sh runs the module's STDOUT as a shell program, and the prompt reaches
// the agent on a PIPE (the `-` marker at the end of the codex argv is what makes it read
// stdin), never as a redirect from a file. So a project root
// holding a quote, a space, a backslash or a `$(…)` is not a string-formatting question, it
// is a question about what bash's own parser does with the emitted line, and the only honest
// way to ask it is to eval the real script in a real bash and print the array back.
//
// Every case below therefore round-trips through `node lib/agent-invocation.js` → `eval` →
// `printf '%s\0'`, and compares the recovered elements byte-for-byte against what
// buildAgentInvocation() said in-process. That also covers the script block at the bottom of
// the module (the part no in-process test reaches) and the `set -u` the loop runs under.

const MODULE = join(dirname(fileURLToPath(import.meta.url)), 'agent-invocation.js')

// The env the loop would have: nothing ambient, so an operator's own RALPH_* exports (or
// this test runner's) cannot decide the argv under test.
function childEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RALPH_AGENT: '',
    RALPH_CODEX_MODEL: '',
    PROJECT_ROOT: '',
    ...extra,
  }
}

// Emit through the real script, eval it in bash exactly as templates/ralph.sh does, and
// print the resulting array NUL-separated so an element containing a newline survives.
function evalArgs(extra = {}) {
  const script = [
    'set -u',
    `eval "$(node ${JSON.stringify(MODULE)})"`,
    `printf '%s\\0' "\${RALPH_AGENT_ARGS[@]}"`,
    `printf 'CLI=%s\\0' "$RALPH_AGENT_CLI"`,
    `printf 'AGENT=%s\\0' "$RALPH_RESOLVED_AGENT"`,
  ].join('\n')
  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: childEnv(extra),
    timeout: 30000,
  })
  const fields = (res.stdout ?? '').split('\0')
  // The trailing empty field after the last NUL is printf's, not an argument.
  if (fields.at(-1) === '') fields.pop()
  const agent = fields.pop()?.replace(/^AGENT=/, '')
  const cli = fields.pop()?.replace(/^CLI=/, '')
  return { status: res.status, stderr: res.stderr ?? '', args: fields, cli, agent }
}

// The nine roots. Each is a real thing a path can contain, and each is a different bash
// hazard: word splitting, quote termination, escape processing, command substitution.
const HOSTILE_ROOTS = [
  ['a space', '/Users/dev/my repo'],
  ['a single quote', "/Users/dev/it's mine"],
  ['a double quote', '/Users/dev/say "hi"'],
  ['a backslash', '/Users/dev/back\\slash'],
  ['a dollar-paren', '/Users/dev/$(id)'],
  ['a backtick', '/Users/dev/`id`'],
  ['a semicolon and an ampersand', '/Users/dev/x; rm -rf /tmp/nope & echo'],
  ['a newline', '/Users/dev/two\nlines'],
  ['a trailing slash', '/Users/dev/repo/'],
]

describe('codex writable root — the emitted argv survives bash eval intact (#221 QA)', () => {
  it.each(HOSTILE_ROOTS)('round-trips a project root containing %s', (_label, root) => {
    const expected = buildAgentInvocation({ RALPH_AGENT: 'codex', PROJECT_ROOT: root }).args
    const got = evalArgs({ RALPH_AGENT: 'codex', PROJECT_ROOT: root })

    expect(got.status, got.stderr).toBe(0)
    expect(got.agent).toBe('codex')
    expect(got.cli).toBe('codex')
    // BYTE-FOR-BYTE, every element: nothing split, nothing dropped, nothing expanded.
    // A `$(id)` that had been evaluated would come back as a username; a space that had
    // been split would come back as two elements.
    expect(got.args).toEqual(expected)
    // The stdin marker is still the last argument after the eval, which is what makes
    // codex read the prompt from the pipe.
    expect(got.args.at(-1)).toBe('-')
  })

  it.each(HOSTILE_ROOTS)('emits ONE well-formed writable-roots list for %s', (_label, root) => {
    const { args } = evalArgs({ RALPH_AGENT: 'codex', PROJECT_ROOT: root })
    const values = args.filter((a) => a.startsWith('sandbox_workspace_write.writable_roots='))
    expect(values).toHaveLength(1)
    expect(args[args.indexOf(values[0]) - 1]).toBe('-c')

    // The value is a TOML list, and its escape set is JSON's — which is the argument the
    // production comment makes, so it is checked by PARSING rather than by string match.
    const parsed = JSON.parse(values[0].slice(values[0].indexOf('=') + 1))
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    // One absolute path, the main root's own `.ralph`, with no doubled separator even
    // when the root arrived with a trailing slash.
    expect(parsed[0]).toBe(join(root.trim(), '.ralph'))
    expect(parsed[0].startsWith('/')).toBe(true)
    expect(parsed[0].endsWith('/.ralph')).toBe(true)
    expect(parsed[0]).not.toContain('//')
    expect(parsed[0]).not.toContain('undefined')
  })

  it('trims a padded project root instead of naming a path with spaces around it', () => {
    // bash exports whatever is in the variable, and a config file with a stray space is
    // ordinary. The trim happens before the join, so the sandbox root is the real
    // directory rather than one whose name begins with a space.
    const { args, status } = evalArgs({ RALPH_AGENT: 'codex', PROJECT_ROOT: '  /Users/dev/repo  ' })
    expect(status).toBe(0)
    expect(args).toContain('sandbox_workspace_write.writable_roots=["/Users/dev/repo/.ralph"]')
  })

  it.each([
    ['unset', {}],
    ['empty', { PROJECT_ROOT: '' }],
    ['whitespace only', { PROJECT_ROOT: '   ' }],
    ['a lone tab', { PROJECT_ROOT: '\t' }],
  ])('omits the flag entirely when PROJECT_ROOT is %s, and still evals', (_label, extra) => {
    // `ralph doctor` and the config-validation pass reach this bridge with no project
    // root, and a `["undefined/.ralph"]` or `["/.ralph"]` would either point codex's
    // sandbox somewhere random or fail on a directory that is not there.
    const { args, status, stderr } = evalArgs({ RALPH_AGENT: 'codex', ...extra })
    expect(status, stderr).toBe(0)
    expect(args.join(' ')).not.toContain('writable_roots')
    expect(args).toEqual(agentSpec('codex').argv.concat('-'))
  })

  it('leaves the CLAUDE argv byte-for-byte unchanged through the same eval', () => {
    // The invariant the slice promised: claude already runs with
    // --dangerously-skip-permissions, so it needs no path — and the hostile root must not
    // reach its argv by any route, including the emitted shell.
    for (const [, root] of HOSTILE_ROOTS) {
      const { args, status, agent } = evalArgs({ RALPH_AGENT: 'claude', PROJECT_ROOT: root })
      expect(status).toBe(0)
      expect(agent).toBe('claude')
      expect(args).toEqual(agentSpec('claude').argv)
      expect(args).not.toContain('-c')
      expect(args.join(' ')).not.toContain('.ralph')
    }
  })

  it('keeps a hostile root out of the STREAM FILTER assignment, which is emitted last', () => {
    // The filter is a multi-line jq program and its assignment must stay the final
    // statement in the block — anything after it would be swallowed into its quoted
    // value. A project root is not part of it, and this pins that the new `-c` pair did
    // not get appended in the wrong place.
    const sh = emitShellAssignments(
      buildAgentInvocation({ RALPH_AGENT: 'codex', PROJECT_ROOT: "/Users/dev/it's" }),
    )
    const filterAt = sh.indexOf('RALPH_AGENT_STREAM_FILTER=')
    const argsAt = sh.indexOf('RALPH_AGENT_ARGS=(')
    expect(argsAt).toBeGreaterThan(-1)
    expect(filterAt).toBeGreaterThan(argsAt)
    expect(sh.slice(filterAt)).not.toContain('.ralph')
    // And the args line closes on its own line — the array is not left open across the
    // filter's newlines.
    const argsLine = sh.slice(argsAt).split('\n')[0]
    expect(argsLine.endsWith(')')).toBe(true)
    // POSIX single-quote escaping, inline: `'` becomes `'\''`, so the path reads
    // `…/it'\''s/.ralph` inside one quoted element.
    expect(argsLine).toContain(`it'\\''s/.ralph`)
  })

  it('writes the program to STDOUT and nothing else, for a codex run with a root', () => {
    // stdout is a shell program: one sentence in it would be eval'd as a command. The
    // only stream that may carry prose is stderr, and an ordinary resolution has none.
    const res = spawnSync(
      'node',
      [MODULE],
      {
        encoding: 'utf8',
        env: childEnv({ RALPH_AGENT: 'codex', PROJECT_ROOT: '/Users/dev/repo' }),
        timeout: 30000,
      },
    )
    expect(res.status).toBe(0)
    expect(res.stderr).toBe('')
    expect(res.stdout).toContain('sandbox_workspace_write.writable_roots=["/Users/dev/repo/.ralph"]')
    // Every line before the multi-line filter is an assignment or an export.
    const upToFilter = res.stdout.slice(0, res.stdout.indexOf('RALPH_AGENT_STREAM_FILTER='))
    for (const line of upToFilter.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^(export [A-Z_]+=|RALPH_[A-Z_]+=)/)
    }
  })
})
