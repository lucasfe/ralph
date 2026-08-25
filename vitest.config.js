import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js', 'src/**/*.test.js', 'lib/**/*.test.js'],
    // #41 — hermeticity for the whole suite, in one place: neutralizes the
    // ambient ralph-domain environment and sandboxes HOME in every worker, so a
    // new test file inherits it without opting in. See the file for the contract.
    setupFiles: ['./test/setup/hermetic-env.js'],
    // Pinned, not inherited: the HOME sandbox is applied through process.env,
    // which only reaches os.homedir() when each worker is its own PROCESS. With a
    // thread-based pool process.env is a thread-local copy, so `home = homedir()`
    // defaults in lib/ would resolve against the developer's real home. Vitest's
    // default already is 'forks', but it was 'threads' before 2.0 and the pool is
    // otherwise a free-for-all perf knob — pinning keeps hermeticity from
    // depending on a default. hermetic-env.js fails loudly if it is overridden.
    pool: 'forks',
    passWithNoTests: true,
  },
})
