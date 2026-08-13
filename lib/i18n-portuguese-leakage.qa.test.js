import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RALPH_HOME } from './paths.js'

// #6 QA regression firewall — issue #6 translated every user-facing Portuguese
// string in the CLI/loop to English. The dev's suite proves the *new* English
// text is present at each call site. This guard proves the *opposite*: that no
// Portuguese survives (or is ever re-introduced) anywhere in the shipped source.
//
// Scope: the code that actually ships — lib/, bin/, templates/ — excluding test
// files (which legitimately carry non-English fixtures such as the `café`
// sanitization input in lib/lock.test.js). If a future edit re-introduces a
// Portuguese string, this test fails in CI instead of the regression shipping.

const ROOTS = ['lib', 'bin', 'templates']
const SHIPPED_EXTENSIONS = ['.js', '.sh']

function isTestFile(path) {
  return /\.(test|qa\.test)\.js$/.test(path)
}

function collectShippedSource(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...collectShippedSource(full))
    } else if (
      SHIPPED_EXTENSIONS.some((ext) => full.endsWith(ext)) &&
      !isTestFile(full)
    ) {
      out.push(full)
    }
  }
  return out
}

const FILES = ROOTS.flatMap((root) => collectShippedSource(join(RALPH_HOME, root)))

// Broad net: Portuguese diacritics never appear in this project's English
// source. (Emoji, ellipsis "…" and em-dash "—" are intentionally NOT in this
// class — they are used throughout the English UI.)
const DIACRITICS = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇñÑ]/

// Curated whole-word Portuguese tokens that appeared in the pre-#6 source and
// have no English homograph, so a hit is unambiguously a translation miss.
const PT_WORDS = [
  'falhou',
  'falharam',
  'fila',
  'vazia',
  'matar',
  'nenhuma',
  'rodando',
  'pulando',
  'puladas',
  'iniciado',
  'encerrada',
  'encerrando',
  'finalizado',
  'marcando',
  'suporta',
  'detectado',
  'existe',
  'tentou',
  'desistiu',
  'mantendo',
  'outra',
  'limpou',
  'restantes',
  'progresso',
  'ausentes',
  'encontrado',
  'abortado',
  'instalar',
  'validando',
  'iteracao',
  'desconhecido',
]
const PT_WORD_RE = new RegExp(`\\b(${PT_WORDS.join('|')})\\b`, 'i')

function scan(file) {
  const text = readFileSync(file, 'utf8')
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (DIACRITICS.test(line) || PT_WORD_RE.test(line)) {
      hits.push(`${relative(RALPH_HOME, file)}:${i + 1}: ${line.trim()}`)
    }
  })
  return hits
}

describe('i18n regression firewall — no Portuguese in shipped source (#6)', () => {
  it('discovers the shipped source files (sanity: the walker is not empty)', () => {
    expect(FILES.length).toBeGreaterThan(10)
    // The command files that #6 translated must be in scope.
    const rels = FILES.map((f) => relative(RALPH_HOME, f))
    expect(rels).toContain('lib/commands/start.js')
    expect(rels).toContain('lib/commands/cycle.js')
    expect(rels).toContain('lib/commands/schedule.js')
    expect(rels).toContain('lib/commands/doctor.js')
    expect(rels).toContain('lib/commands/stop.js')
    expect(rels).toContain('templates/ralph.sh')
  })

  it('excludes test files (so legitimate non-English fixtures do not trip it)', () => {
    const rels = FILES.map((f) => relative(RALPH_HOME, f))
    expect(rels.some((r) => r.endsWith('.test.js'))).toBe(false)
    expect(rels).not.toContain('lib/lock.test.js')
  })

  it('contains ZERO Portuguese diacritics or tokens across all shipped source', () => {
    const allHits = FILES.flatMap(scan)
    expect(
      allHits,
      `Portuguese leaked into shipped source:\n${allHits.join('\n')}`,
    ).toEqual([])
  })
})
