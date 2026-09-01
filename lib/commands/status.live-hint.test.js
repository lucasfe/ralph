import { describe, it, expect } from 'vitest'
import { renderStatus } from './status.js'

// #169 — the `attach` row of the RUNNING view names `ralph live` (#167) and keeps the
// `tmux attach -t <session>` command beside it, in parentheses.
//
// `renderStatus` is a pure function, so this whole slice is a text assertion: a line list
// in, a line list out, no I/O and no seams to stub. The two claims worth pinning are the
// two the issue is a trade between:
//
//   1. ONE ROW, not two. Every two-column row in this view puts its value at column 14
//      (`  attach     `), and a second line under it would read as a NEW KEY — the block
//      is `queue`/`pace`/`eta`/`spend`/`attach`/`kill`, all single rows. So the tmux
//      command goes in parentheses on the same line rather than on a continuation line
//      the way the launch box takes it, and the view's height is unchanged.
//   2. THE SCHEDULED BRANCH IS UNTOUCHED. A live `ralph cycle` run has no tmux session,
//      so there is nothing to attach to and `ralph live` would be exactly as wrong there
//      as `tmux attach` already is. It must not gain the mention.
//
// The session name survives in the parenthetical, which is what a reader with three
// concurrent loops actually reads that row for.

const SESSION = 'ralph-ralph-b36ff7b1'

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

const runningRecord = (overrides = {}) => ({
  schema: 1,
  run_id: SESSION,
  session: SESSION,
  source: 'github',
  status: 'running',
  started_at: RUN_STARTED.toISOString(),
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
  ...overrides,
})

const view = (overrides = {}) =>
  renderStatus({
    mode: 'running',
    record: runningRecord(),
    session: SESSION,
    queue: 6,
    now: NOW,
    ...overrides,
  })

const ATTACH_ROW = `  attach     ralph live  (tmux attach -t ${SESSION})`

describe('renderStatus — the attach row names `ralph live` (#169)', () => {
  it('names `ralph live` and keeps the tmux command, on one row, above `kill`', () => {
    expect(view({ attachable: true }).slice(-2)).toEqual([ATTACH_ROW, '  kill       ralph stop'])
  })

  it('keeps the row on the view’s value column and adds no line to it', () => {
    // The column every other two-column row uses: 2 spaces, an 11-wide label field.
    const lines = view({ attachable: true })
    expect(lines.at(-2).startsWith('  attach     ')).toBe(true)
    // 13 since #56 — the same height as before this issue, because the tmux command
    // shares the attach row rather than taking one of its own.
    expect(lines).toHaveLength(13)
  })

  it('still names the session, so concurrent loops stay distinguishable', () => {
    expect(view({ attachable: true }).at(-2)).toContain(SESSION)
  })

  it('leaves the SCHEDULED branch alone — no session, no `ralph live`', () => {
    // A live `ralph cycle` run under launchd. There is nothing to attach to, so the two
    // rows point at the log it actually writes and mention neither command.
    const lines = view({ attachable: false })
    expect(lines.slice(-2)).toEqual([
      '  scheduled  ralph cycle run — no tmux session to attach to',
      '  logs       tail -f logs/ralph-cycle.out.log',
    ])
    expect(lines.join('\n')).not.toContain('ralph live')
  })

  it('mentions `ralph live` in no other mode’s view', () => {
    // The report card and the never-run pointer are about a run that is over or never
    // was; neither has a session, so neither may advertise attaching to one.
    for (const mode of ['idle', 'interrupted', 'never-run']) {
      const lines = renderStatus({
        mode,
        record: mode === 'never-run' ? null : runningRecord({ status: 'partial', finished_at: new Date(NOW).toISOString(), ok: 2, failed: 1 }),
        session: SESSION,
        queue: 6,
        now: NOW,
      })
      expect(lines.join('\n'), mode).not.toContain('ralph live')
    }
  })
})
