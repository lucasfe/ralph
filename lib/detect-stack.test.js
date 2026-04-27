import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { detectStack } from './detect-stack.js'

function makeFs(files) {
  return Volume.fromJSON(files, '/project')
}

describe('detectStack', () => {
  it('detects pnpm from pnpm-lock.yaml', () => {
    const fs = makeFs({ '/project/pnpm-lock.yaml': '', '/project/package.json': '{}' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'pnpm install --frozen-lockfile',
      test: 'pnpm test',
      lint: 'pnpm lint',
      stack: 'pnpm',
    })
  })

  it('detects yarn from yarn.lock', () => {
    const fs = makeFs({ '/project/yarn.lock': '', '/project/package.json': '{}' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'yarn install --frozen-lockfile',
      test: 'yarn test',
      lint: 'yarn lint',
      stack: 'yarn',
    })
  })

  it('detects npm from a lone package.json', () => {
    const fs = makeFs({ '/project/package.json': '{}' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'npm ci',
      test: 'npm test',
      lint: 'npm run lint',
      stack: 'npm',
    })
  })

  it('detects python from pyproject.toml', () => {
    const fs = makeFs({ '/project/pyproject.toml': '[project]\nname = "demo"\n' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'pip install -e .',
      test: 'pytest',
      lint: 'ruff check .',
      stack: 'python',
    })
  })

  it('detects pip from requirements.txt without pyproject.toml', () => {
    const fs = makeFs({ '/project/requirements.txt': 'requests==2.31.0\n' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'pip install -r requirements.txt',
      test: 'pytest',
      lint: '',
      stack: 'pip',
    })
  })

  it('detects go from go.mod', () => {
    const fs = makeFs({ '/project/go.mod': 'module example.com/demo\n' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'go mod download',
      test: 'go test ./...',
      lint: 'go vet ./...',
      stack: 'go',
    })
  })

  it('detects rust from Cargo.toml', () => {
    const fs = makeFs({ '/project/Cargo.toml': '[package]\nname = "demo"\n' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'cargo fetch',
      test: 'cargo test',
      lint: 'cargo clippy',
      stack: 'rust',
    })
  })

  it('detects ruby from Gemfile', () => {
    const fs = makeFs({ '/project/Gemfile': "source 'https://rubygems.org'\n" })
    expect(detectStack('/project', fs)).toEqual({
      install: 'bundle install',
      test: 'bundle exec rake test',
      lint: '',
      stack: 'ruby',
    })
  })

  it('detects php from composer.json', () => {
    const fs = makeFs({ '/project/composer.json': '{}' })
    expect(detectStack('/project', fs)).toEqual({
      install: 'composer install',
      test: 'composer test',
      lint: '',
      stack: 'php',
    })
  })

  it('falls back to unknown when no manifest is present', () => {
    const fs = makeFs({ '/project/README.md': '# demo' })
    expect(detectStack('/project', fs)).toEqual({
      install: '',
      test: '',
      lint: '',
      stack: 'unknown',
    })
  })

  it('falls back to unknown for an empty project directory', () => {
    const fs = makeFs({ '/project/.gitkeep': '' })
    expect(detectStack('/project', fs).stack).toBe('unknown')
  })

  it('prefers pnpm over yarn when both lockfiles coexist', () => {
    const fs = makeFs({
      '/project/pnpm-lock.yaml': '',
      '/project/yarn.lock': '',
      '/project/package.json': '{}',
    })
    expect(detectStack('/project', fs).stack).toBe('pnpm')
  })

  it('prefers yarn over npm when yarn.lock and package.json coexist', () => {
    const fs = makeFs({
      '/project/yarn.lock': '',
      '/project/package.json': '{}',
    })
    expect(detectStack('/project', fs).stack).toBe('yarn')
  })

  it('prefers pyproject.toml over requirements.txt', () => {
    const fs = makeFs({
      '/project/pyproject.toml': '[project]\nname = "demo"\n',
      '/project/requirements.txt': 'requests==2.31.0\n',
    })
    expect(detectStack('/project', fs).stack).toBe('python')
  })

  it('prefers Node manifests over Python ones when both exist', () => {
    const fs = makeFs({
      '/project/package.json': '{}',
      '/project/pyproject.toml': '[project]\nname = "demo"\n',
    })
    expect(detectStack('/project', fs).stack).toBe('npm')
  })

  it('returns a fresh object on each call (no shared mutation)', () => {
    const fs = makeFs({ '/project/go.mod': 'module x\n' })
    const a = detectStack('/project', fs)
    a.install = 'mutated'
    const b = detectStack('/project', fs)
    expect(b.install).toBe('go mod download')
  })
})
