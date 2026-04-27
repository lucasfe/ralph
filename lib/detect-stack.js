import { existsSync as realExistsSync } from 'node:fs'
import { join } from 'node:path'

const STACKS = {
  pnpm: {
    install: 'pnpm install --frozen-lockfile',
    test: 'pnpm test',
    lint: 'pnpm lint',
    stack: 'pnpm',
  },
  yarn: {
    install: 'yarn install --frozen-lockfile',
    test: 'yarn test',
    lint: 'yarn lint',
    stack: 'yarn',
  },
  npm: {
    install: 'npm ci',
    test: 'npm test',
    lint: 'npm run lint',
    stack: 'npm',
  },
  python: {
    install: 'pip install -e .',
    test: 'pytest',
    lint: 'ruff check .',
    stack: 'python',
  },
  pip: {
    install: 'pip install -r requirements.txt',
    test: 'pytest',
    lint: '',
    stack: 'pip',
  },
  go: {
    install: 'go mod download',
    test: 'go test ./...',
    lint: 'go vet ./...',
    stack: 'go',
  },
  rust: {
    install: 'cargo fetch',
    test: 'cargo test',
    lint: 'cargo clippy',
    stack: 'rust',
  },
  ruby: {
    install: 'bundle install',
    test: 'bundle exec rake test',
    lint: '',
    stack: 'ruby',
  },
  php: {
    install: 'composer install',
    test: 'composer test',
    lint: '',
    stack: 'php',
  },
  unknown: {
    install: '',
    test: '',
    lint: '',
    stack: 'unknown',
  },
}

const DETECTION_ORDER = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package.json', 'npm'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'pip'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
]

export function detectStack(projectDir, fsImpl) {
  const existsSync =
    fsImpl && typeof fsImpl.existsSync === 'function' ? fsImpl.existsSync.bind(fsImpl) : realExistsSync

  for (const [manifest, key] of DETECTION_ORDER) {
    if (existsSync(join(projectDir, manifest))) {
      return { ...STACKS[key] }
    }
  }
  return { ...STACKS.unknown }
}

export const STACK_TABLE = STACKS
