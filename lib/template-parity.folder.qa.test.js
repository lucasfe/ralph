import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { templatePath } from './paths.js'

// QA augmentation for #221's prompt contract. lib/template-parity.test.js checks that the
// folder prompt no longer tells the agent to check a branch out, that step 3 describes the
// detached tree, and that every task path is rooted at {{MAIN_REPO_ROOT}}. Those are all
// checks against the template ALONE.
//
// This file checks the prompt against the OTHER FILE IN THE PAIR. The prompt is the only
// specification the agent gets, and half of what it says is a claim about what
// templates/ralph.sh will do after the invocation returns: who moves the branch, who sweeps
// the task file, what the park branch is called. A sentence like that cannot be graded by
// reading the prose — it is true or false depending on the bash, so each one below is
// asserted against the bash (or against lib/worktree.js, where the bash delegates).
//
// That is also the class of defect this repository blocks reviews on: prose that says
// something the code does not do.

const folder = readFileSync(templatePath('prompt-team-folder.md'), 'utf8')
const jira = readFileSync(templatePath('prompt-team-jira.md'), 'utf8')
const loop = readFileSync(templatePath('ralph.sh'), 'utf8')
const worktreeLib = readFileSync(new URL('./worktree.js', import.meta.url), 'utf8')

// Comment lines are prose about the code, not the code — a `#` mention of "push" is not a
// push. This is the same reduction test/loop.worktree.test.js applies before grepping the
// loop for behaviour.
const loopCode = loop
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

describe('the folder prompt promises only what templates/ralph.sh actually does (#221 QA)', () => {
  it('does not promise a push that no arm of the loop performs', () => {
    // THE FINDING, since fixed. templates/prompt-team-folder.md step 7 used to say:
    //
    //   "The bash pushes `{{DEV_BRANCH}}` for you after this invocation returns."
    //
    // The loop runs no `push` at all — not in the folder arm, not anywhere — and the same
    // template's step 3 says so in as many words ("this source never pushes").
    // templates/prompt-team-jira.md spells the truth out for all three arms: "Ralph's loop
    // script runs no `push` on any of its three task-source arms". #221 deleted the step 7
    // sentence, and this row is what keeps it (or any re-phrasing of it) from coming back.
    //
    // It matters beyond tidiness, in both directions: an agent that believes the branch is
    // published has been told its work is durable when it exists on exactly one disk, and
    // an agent that notices the promise was not kept is the kind of agent that decides to
    // push "to compensate" — which is what the jira template's next sentence exists to
    // forbid.
    //
    // Asserted as a cross-file implication rather than as a banned string, so it stays
    // honest if a future slice really does add a push: claim it only if the loop does it.
    const loopPushes = /(^|\s)git\s+push/.test(loopCode)
    const promises = /bash pushes|loop pushes (it|`?\{\{DEV_BRANCH\}\}`?)/i.test(folder)
    expect(
      { loopPushes, promises },
      'templates/prompt-team-folder.md tells the agent the bash pushes {{DEV_BRANCH}}, and templates/ralph.sh contains no push',
    ).toEqual({ loopPushes, promises: loopPushes })
  })

  it('says who moves the branch in the same terms the loop uses', () => {
    // Step 3's version is the accurate one, and it is accurate because of these two lines
    // in the loop: `worktree.js advance` and the `||` warning beside it.
    expect(loopCode).toContain('worktree.js" advance')
    expect(folder).toMatch(/the loop advances\s+`\{\{DEV_BRANCH\}\}`/)
    expect(folder).toMatch(/parks your commit on a `ralph\/task-N`/)
  })

  it('names the park branch exactly as lib/worktree.js writes it', () => {
    // The prompt tells the agent where to look for a parked commit. That name is built in
    // two places — `ralph/${handle}` in the library, `task-$num` in the bash — so the
    // sentence is only true while all three agree.
    expect(worktreeLib).toContain('const parkBranch = `ralph/${handle}`')
    expect(loopCode).toContain('task_handle="task-$num"')
    expect(folder).toContain('ralph/task-N')
  })

  it('describes the sweep the bash really performs on an unfinished task', () => {
    // "The outer bash sweeps the task file to …/afk/failed/" — which is the
    // folder-queue `fail` call in the loop's folder arm, and the reason the queue drains.
    expect(loopCode).toContain('folder-queue.js" fail')
    expect(folder).toMatch(/sweeps the task file to\s+`\{\{MAIN_REPO_ROOT\}\}\/\.ralph\/tasks\/afk\/failed\/`/)
  })

  it('tells the agent to create no branch, and the loop creates none for it', () => {
    // `--detach` is the whole reason the instruction is phrased this way: there is no
    // `task-N` branch, so a commit made anywhere but the detached HEAD is a commit the
    // advance cannot find.
    expect(loopCode).toContain('create-detached')
    expect(loopCode).not.toContain('worktree add -B')
    expect(folder).toMatch(/\*\*Create no branch and switch to none\*\*/)
    // And no instruction anywhere in the template contradicts that.
    expect(folder).not.toMatch(/git\s+switch/)
    expect(folder).not.toMatch(/git\s+checkout/)
    expect(folder).not.toMatch(/git\s+branch\s+-/)
  })

  it('never sends the agent to a remote ref for its base', () => {
    // The github templates cut from `origin/{{DEV_BRANCH}}` and push a feature branch;
    // this one must not mention a remote base at all, because the folder-mode create never
    // fetches and a commit a previous task left on the local branch is on no remote.
    expect(folder).not.toContain('origin/{{DEV_BRANCH}}')
    expect(folder).not.toMatch(/git\s+fetch/)
    expect(folder).not.toMatch(/git\s+pull/)
  })

  it('keeps the jira template right about all three arms, since it speaks for them', () => {
    // Cross-checked here because it is the sentence the folder template used to contradict,
    // and a future push would make BOTH stale — this is the pair that has to move together.
    // `\s+` across the wrap: the sentence is hard-wrapped in the template.
    expect(jira).toMatch(/runs no `push` on any of its three task-source\s+arms/)
    expect(/(^|\s)git\s+push/.test(loopCode)).toBe(false)
  })
})
