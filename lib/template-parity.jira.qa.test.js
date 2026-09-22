import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { templatePath } from './paths.js'

// QA augmentation for #224's prompt contract, the jira twin of lib/template-parity.folder.qa.test.js.
// #224 gives TASK_SOURCE=jira the same detached-worktree treatment folder mode got in #221,
// REUSING lib/worktree.js's advance/advanceOrPark on the same advance-or-park seam. Half of what
// the jira prompt now says is a claim about what templates/ralph.sh does after the invocation
// returns — who moves the branch, what the park branch is called, where the log lives — and a
// sentence like that is true or false depending on the bash, not the prose. So each one below is
// asserted against the bash (or against lib/worktree.js, where the bash delegates).
//
// That is also the class of defect this repository blocks reviews on: prose that says something
// the code does not do.

const jira = readFileSync(templatePath('prompt-team-jira.md'), 'utf8')
const folder = readFileSync(templatePath('prompt-team-folder.md'), 'utf8')
const loop = readFileSync(templatePath('ralph.sh'), 'utf8')
const worktreeLib = readFileSync(new URL('./worktree.js', import.meta.url), 'utf8')

// Comment lines are prose about the code, not the code — the same reduction the loop tests use
// before grepping for behaviour.
const loopCode = loop
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

describe('the jira prompt promises only what templates/ralph.sh actually does (#224 QA)', () => {
  it('no longer tells the agent to check the dev branch out and pull it', () => {
    // THE FINDING, since fixed. Step 3 used to say `git checkout {{DEV_BRANCH}} && git pull`.
    // The loop now prepares a DETACHED worktree at the local tip and never fetches for the
    // create, so a checkout would fail (branch busy in the main tree) and a pull would base the
    // work on origin, dropping the previous ticket's local commit — this source never pushes.
    expect(jira).not.toContain('git checkout {{DEV_BRANCH}} && git pull')
    expect(jira).not.toMatch(/git\s+checkout/)
    expect(jira).not.toMatch(/git\s+pull/)
    expect(jira).not.toMatch(/git\s+fetch/)
    expect(jira).not.toMatch(/git\s+switch/)
  })

  it('keeps the step 3 heading but describes the prepared detached tree instead', () => {
    expect(jira).toContain('3. **Prepare working tree**')
    const step3 = jira.slice(jira.indexOf('3. **Prepare working tree**'), jira.indexOf('3b. **Triage'))
    expect(step3).toMatch(/detached/i)
    expect(step3).toMatch(/\{\{DEV_BRANCH\}\}/)
    // The one thing the agent must not do on a detached HEAD.
    expect(step3).toMatch(/create no branch|switch to none/i)
    // And the truth about who moves the branch afterward.
    expect(step3).toMatch(/advance/i)
    expect(step3).toMatch(/park/i)
  })

  it('says who moves the branch in the same terms the loop uses, and the loop really does it', () => {
    // Step 3's version is accurate because of two lines in the loop's jira arm: `worktree.js
    // advance` and the `||` warning beside it.
    expect(loopCode).toContain('worktree.js" advance')
    expect(jira).toMatch(/the loop advances\s+`\{\{DEV_BRANCH\}\}`/)
  })

  it('names the park branch consistently with lib/worktree.js and the loop handle', () => {
    // The prompt tells the agent where a parked commit is reachable. That name is built in two
    // places — `ralph/${handle}` in the library, `task-$task_log_handle` in the bash's jira
    // case — so the sentence is only true while all three agree.
    expect(worktreeLib).toContain('const parkBranch = `ralph/${handle}`')
    expect(loopCode).toContain('task_handle="task-$task_log_handle"')
    expect(jira).toContain('ralph/task-')
  })

  it('cuts the tree with the same detached create the folder arm uses, on no remote base', () => {
    // `--detach` (via create-detached) is why the agent is told to create no branch: there is no
    // `task-<key>` branch, so a commit made anywhere but the detached HEAD is one the advance
    // cannot find. And no remote base: the jira create never fetches.
    expect(loopCode).toContain('create-detached "$PROJECT_ROOT" "$task_handle"')
    expect(jira).not.toContain('origin/{{DEV_BRANCH}}')
  })

  it('reaches the per-ticket log through {{MAIN_REPO_ROOT}}, not the worktree it runs in', () => {
    // The log lives in the main checkout (the loop anchors LOG_DIR to $PROJECT_ROOT, which the
    // loop never leaves), and the worktree is a different directory in jira mode now — so a bare
    // `logs/…` would name a file inside the agent's own tree that the loop never writes.
    expect(jira).toContain('{{MAIN_REPO_ROOT}}')
    expect(jira).toContain('{{MAIN_REPO_ROOT}}/logs/ralph-issue-{{RALPH_TASK_KEY}}.log')
  })

  it('promises no push, and the loop performs none — the sentence the folder pair also keeps', () => {
    expect(jira).toMatch(/commit stays local/i)
    expect(jira).not.toMatch(/bash pushes/i)
    expect(/(^|\s)git\s+push/.test(loopCode)).toBe(false)
    // Cross-checked against the folder sibling, since the two speak for the same delivery shape.
    expect(folder).not.toMatch(/bash pushes/i)
  })
})
