import { classifyInstall } from '../../lib/install-target.js'

// #200: an install layout for the update gate to classify, injected.
//
// The gate's notice names the command THIS layout is updated by, and the weekly check
// asks the channel it installs from — so from #200 on, a suite that reaches the notice
// without injecting a layout is asserting about the machine it runs on. The default
// `classifyInstall` reads RALPH_HOME, which in a vitest worker is this checkout: it has
// a `.git`, so it classifies `linked`, a refusal that carries no command at all. That
// answer is right for a dev checkout and useless as a fixture.
//
// So every suite whose subject is the notice or the prompt — not the layout — pins the
// layout that produced #24's original bytes: a plain npm global install, which names
// `npm i -g @lucasfe/ralph` and asks the npm registry. The classification is the REAL
// one: only the two inputs it reads are replaced, so a change to how a global install
// is recognized reaches these suites instead of passing a hand-written twin.
export const NPM_GLOBAL_ROOT = '/usr/local/lib/node_modules'
export const NPM_GLOBAL_RALPH = `${NPM_GLOBAL_ROOT}/@lucasfe/ralph`

// The two inputs, spelled here so a caller never has to know them:
//   - `exec` answers the `npm root -g` probe. It is the layout's own spawner, NOT the
//     run's: the gate deliberately hands `classify` no exec (a background notice must
//     not cost a subprocess), so a suite that counts spawns on its own `exec` still
//     counts zero.
//   - `fs` answers "no .git, not a symlink" for the two probes that would otherwise
//     turn this path into a refusal, without touching the real filesystem (#41).
const probeFs = {
  existsSync: () => false,
  lstatSync: () => ({ isSymbolicLink: () => false }),
}

export function npmGlobalLayout({ ralphHome = NPM_GLOBAL_RALPH, root = NPM_GLOBAL_ROOT } = {}) {
  const classify = async (bag) => {
    classify.calls.push(bag)
    return classifyInstall({
      ...bag,
      ralphHome,
      exec: async () => ({ exitCode: 0, stdout: `${root}\n`, stderr: '' }),
      fs: probeFs,
    })
  }
  classify.calls = []
  return classify
}
