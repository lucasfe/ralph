import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { initCommand } from './init.js'

// #5 QA augmentation. The dev's happy-path tests cover the unset→write and
// already-set→display flows. These attack setupWhatsApp's adversarial corners
// through a full initCommand run: partial creds (phone-only / key-only), the
// masking rules (exactly-4-char key, 5-char key, empty key with phone set),
// change→both-blank (no write), change→phone-only (key preserved), unset→write
// with unrelated content preserved, and the non-TTY silent-skip invariant that
// must never fire a prompt or touch the file.
//
// Agent + source are passed as flags so the ONLY interactive prompts are
// setupWhatsApp's own — promptAgent/promptSource are never reached.

const PROJECT = '/project'
const HOME = '/home/test'
const GLOBAL = join(HOME, '.config', 'ralph', '.env')

function makeStream() {
  const chunks = []
  return { write: (s) => (chunks.push(s), true), output: () => chunks.join('') }
}

function makeExec() {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    if (key === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: PROJECT, stderr: '' }
    if (key === 'git symbolic-ref refs/remotes/origin/HEAD')
      return { exitCode: 0, stdout: 'refs/remotes/origin/main', stderr: '' }
    if (key === 'git branch -a') return { exitCode: 0, stdout: '* main\n', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

function newVol(seedGlobal) {
  const seed = { [`${PROJECT}/.keep`]: '' }
  if (seedGlobal != null) seed[GLOBAL] = seedGlobal
  return Volume.fromJSON(seed, '/')
}

// ask keyed by the question text; promptValue keyed by phone/key. Any missing
// answer throws so a stray prompt is loud, not silent.
function makeAsk(answers) {
  return async (question) => {
    if (question.includes('Set up WhatsApp')) return answers.setup ?? false
    if (question.includes('Change it?')) return answers.change ?? false
    throw new Error(`unexpected ask(): ${question}`)
  }
}

function makePromptValue(values) {
  return async (question) => {
    if (/phone/i.test(question)) return values.phone ?? ''
    if (/key/i.test(question)) return values.key ?? ''
    throw new Error(`unexpected promptValue(): ${question}`)
  }
}

function run(vol, opts = {}) {
  const stdout = makeStream()
  return initCommand({
    cwd: PROJECT,
    stdout,
    stderr: makeStream(),
    exec: makeExec(),
    fs: vol,
    agent: 'claude',
    source: 'github',
    isTTY: true,
    home: HOME,
    processEnv: {},
    ...opts,
  }).then((result) => ({ result, stdout: stdout.output() }))
}

describe('QA setupWhatsApp — already-configured display with partial creds', () => {
  it('phone-only file is treated as configured; key shows "(unset)"', async () => {
    const vol = newVol('WHATSAPP_PHONE=+15551234567\n')
    const { stdout } = await run(vol, {
      ask: makeAsk({ change: false }),
      promptValue: makePromptValue({}),
    })
    expect(stdout).toContain('already configured')
    expect(stdout).toContain('WHATSAPP_PHONE: +15551234567')
    expect(stdout).toContain('CALLMEBOT_KEY:  (unset)')
    // "Set up WhatsApp?" gate must NOT appear — hasCreds short-circuited it.
    expect(stdout).not.toContain('Set up WhatsApp notifications globally?')
  })

  it('key-only file is treated as configured; phone shows "(unset)"', async () => {
    const vol = newVol('CALLMEBOT_KEY=abcdefgh\n')
    const { stdout } = await run(vol, {
      ask: makeAsk({ change: false }),
      promptValue: makePromptValue({}),
    })
    expect(stdout).toContain('WHATSAPP_PHONE: (unset)')
    // 8-char key → 4 dots + last 4 visible.
    expect(stdout).toContain('CALLMEBOT_KEY:  ••••efgh')
  })

  it('empty-valued key with a real phone shows "(unset)" (empty is falsy, not masked)', async () => {
    const vol = newVol('WHATSAPP_PHONE=+1\nCALLMEBOT_KEY=\n')
    const { stdout } = await run(vol, {
      ask: makeAsk({ change: false }),
      promptValue: makePromptValue({}),
    })
    expect(stdout).toContain('CALLMEBOT_KEY:  (unset)')
  })
})

describe('QA setupWhatsApp — maskSecret boundaries via displayed output', () => {
  it('a key of EXACTLY 4 chars is fully masked (no chars leak)', async () => {
    const vol = newVol('CALLMEBOT_KEY=wxyz\n')
    const { stdout } = await run(vol, {
      ask: makeAsk({ change: false }),
      promptValue: makePromptValue({}),
    })
    expect(stdout).toContain('CALLMEBOT_KEY:  ••••')
    expect(stdout).not.toContain('wxyz')
  })

  it('a key of 5 chars shows exactly 1 dot + the last 4', async () => {
    const vol = newVol('CALLMEBOT_KEY=vwxyz\n')
    const { stdout } = await run(vol, {
      ask: makeAsk({ change: false }),
      promptValue: makePromptValue({}),
    })
    expect(stdout).toContain('CALLMEBOT_KEY:  •wxyz')
    expect(stdout).not.toContain('vwxyz')
  })
})

describe('QA setupWhatsApp — change flow write semantics', () => {
  it('change→yes but BOTH blank writes nothing and reports "No changes"', async () => {
    const original = '# my creds\nWHATSAPP_PHONE=+1\nCALLMEBOT_KEY=secret123\n'
    const vol = newVol(original)
    const { stdout } = await run(vol, {
      ask: makeAsk({ change: true }),
      promptValue: makePromptValue({ phone: '', key: '' }),
    })
    expect(stdout).toContain('No changes')
    // File is byte-for-byte unchanged.
    expect(vol.readFileSync(GLOBAL, 'utf8')).toBe(original)
    expect(stdout).not.toContain('Updated WhatsApp credentials')
  })

  it('change→yes with ONLY a new phone upserts phone and PRESERVES the existing key', async () => {
    const vol = newVol('WHATSAPP_PHONE=+1\nCALLMEBOT_KEY=keepme\n')
    const { stdout } = await run(vol, {
      ask: makeAsk({ change: true }),
      promptValue: makePromptValue({ phone: '+999', key: '' }),
    })
    const out = vol.readFileSync(GLOBAL, 'utf8')
    expect(out).toContain('WHATSAPP_PHONE=+999')
    expect(out).toContain('CALLMEBOT_KEY=keepme')
    expect(out).not.toContain('WHATSAPP_PHONE=+1\n')
    expect(stdout).toContain('Updated WhatsApp credentials')
  })

  it('change→yes with ONLY a new key upserts key and PRESERVES the existing phone', async () => {
    const vol = newVol('WHATSAPP_PHONE=+keep\nCALLMEBOT_KEY=old\n')
    await run(vol, {
      ask: makeAsk({ change: true }),
      promptValue: makePromptValue({ phone: '', key: 'newkey' }),
    })
    const out = vol.readFileSync(GLOBAL, 'utf8')
    expect(out).toContain('WHATSAPP_PHONE=+keep')
    expect(out).toContain('CALLMEBOT_KEY=newkey')
    expect(out).not.toContain('CALLMEBOT_KEY=old')
  })
})

describe('QA setupWhatsApp — unset→write preserves surrounding global content', () => {
  it('writes both creds while preserving a pre-existing comment and unrelated var', async () => {
    // File exists but has NO whatsapp creds → hasCreds false → gate path.
    const vol = newVol('# hand-written global config\nRALPH_STARTUP_MESSAGE=hello\n')
    const { stdout } = await run(vol, {
      ask: makeAsk({ setup: true }),
      promptValue: makePromptValue({ phone: '+15550001111', key: 'apikey42' }),
    })
    const out = vol.readFileSync(GLOBAL, 'utf8')
    expect(out).toContain('# hand-written global config')
    expect(out).toContain('RALPH_STARTUP_MESSAGE=hello')
    expect(out).toContain('WHATSAPP_PHONE=+15550001111')
    expect(out).toContain('CALLMEBOT_KEY=apikey42')
    expect(stdout).toContain('Saved WhatsApp credentials')
  })

  it('unset gate declined → nothing written, "Skipping" reported', async () => {
    const vol = newVol() // no global file at all
    const { stdout } = await run(vol, {
      ask: makeAsk({ setup: false }),
      promptValue: makePromptValue({}),
    })
    expect(stdout).toContain('Skipping WhatsApp setup')
    expect(vol.existsSync(GLOBAL)).toBe(false)
  })
})

describe('QA setupWhatsApp — non-TTY invariant', () => {
  it('non-TTY with an existing global file: file untouched and NO prompt fires', async () => {
    const original = '# creds\nWHATSAPP_PHONE=+1\nCALLMEBOT_KEY=secret\n'
    const vol = newVol(original)
    const boom = () => {
      throw new Error('prompt fired in non-TTY mode')
    }
    const { stdout } = await run(vol, {
      isTTY: false,
      ask: boom,
      promptValue: boom,
    })
    // Byte-for-byte identical — setupWhatsApp returned before any read/write.
    expect(vol.readFileSync(GLOBAL, 'utf8')).toBe(original)
    // No WhatsApp interactive chatter in the transcript.
    expect(stdout).not.toContain('already configured')
    expect(stdout).not.toContain('Set up WhatsApp notifications globally?')
  })
})
