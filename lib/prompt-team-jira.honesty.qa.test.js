import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { templatePath } from './paths.js'

// QA augmentation for #224's COMMENT-HONESTY criterion, which is the review class this repository
// blocks on: prose that claims something the code does not do. lib/worktree.js can PARK a jira
// ticket's commit on `ralph/task-<key>` instead of advancing `{{DEV_BRANCH}}` — so a step-7 comment
// that flatly told the agent to report the commit as living "on `{{DEV_BRANCH}}`" (as the template
// did before #224) would be a lie exactly on the park path, and the ticket comment is what outlives
// the run. The dev's lib/template-parity.jira.qa.test.js pins step 3 (the working-tree prose); this
// pins step 7 (the comment the agent writes to the board), which that file does not cover.

const jira = readFileSync(templatePath('prompt-team-jira.md'), 'utf8')

// The "where the commit lives" bullet of step 7, sliced off at the next bullet so the assertions
// are scoped to the sentence that describes the commit's location and nowhere else.
const anchor = '**where the commit lives**'
const start = jira.indexOf(anchor)
const commitLivesBullet = start === -1 ? '' : jira.slice(start, jira.indexOf('**test and lint result**'))

describe('the jira step-7 comment does not lie about where a parked commit lives (#224 QA)', () => {
  it('has the "where the commit lives" bullet at all', () => {
    // If step 7 were re-numbered or the bullet renamed, every assertion below would pass vacuously
    // against an empty slice. Fail loudly instead.
    expect(start).not.toBe(-1)
    expect(commitLivesBullet).not.toBe('')
  })

  it('tells the agent to report the ACTUAL branch, not assume {{DEV_BRANCH}}', () => {
    expect(commitLivesBullet).toMatch(/reachable from/i)
    expect(commitLivesBullet).toMatch(/rather than assuming\s+`\{\{DEV_BRANCH\}\}`/)
    // And it names the park branch as the alternative, so the agent knows what to report.
    expect(commitLivesBullet).toContain('ralph/task-')
    // Both real outcomes are named: advance OR park.
    expect(commitLivesBullet).toMatch(/advances?\s+`\{\{DEV_BRANCH\}\}`/)
    expect(commitLivesBullet).toMatch(/park/i)
  })

  it('does not carry the pre-#224 hard claim that the commit is simply on {{DEV_BRANCH}}', () => {
    // The removed phrasing named `{{DEV_BRANCH}}` as "the branch it is on". Any resurrection of a
    // sentence that states the branch as a settled fact — rather than something to be reported —
    // is the defect this test exists to catch.
    expect(jira).not.toMatch(/the \*\*branch\*\* it is on,\s*`\{\{DEV_BRANCH\}\}`/)
    expect(commitLivesBullet).not.toMatch(/it is on\s+`\{\{DEV_BRANCH\}\}`/)
  })

  it('still promises the commit is local and unpushed — the part that stays true either way', () => {
    expect(commitLivesBullet).toMatch(/local and unpushed/i)
  })
})
