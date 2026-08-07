// PURE task-file helpers — NO I/O (#565). A folder-mode task is a numbered `.md`
// file with optional YAML-ish frontmatter (title + labels) delimited by `---`
// followed by a markdown body. Identity is the leading integer of the filename
// (001-fix-login.md → 1), and the next number is max(N)+1 across ALL task
// directories in BOTH lanes (afk + hitl). Every function is deterministic and
// takes plain strings/arrays so it is trivially testable and hermetic.

function stripQuotes(value) {
  const v = value.trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1)
  }
  return v
}

// Parse a labels value. Accepts a comma list (`bug, ui`) or a bracketed list
// (`[bug, ui]`). Empty entries are dropped. Returns a string array.
function parseLabels(raw) {
  if (raw == null) return []
  let s = String(raw).trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1)
  }
  if (s === '') return []
  return s
    .split(',')
    .map((x) => stripQuotes(x).trim())
    .filter(Boolean)
}

// Parse a task `.md` file into { title, labels, body }. Frontmatter is the block
// between the FIRST two `---` fences at the top of the file. A file with no
// frontmatter yields an empty title/labels and the whole text as the body.
export function parseTaskFile(text) {
  const src = text == null ? '' : String(text)
  const result = { title: '', labels: [], body: src.trim() }

  const lines = src.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return result

  // Find the closing fence.
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close === -1) return result

  for (let i = 1; i < close; i++) {
    const line = lines[i]
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2]
    if (key === 'title') {
      result.title = stripQuotes(value)
    } else if (key === 'labels') {
      result.labels = parseLabels(value)
    }
  }

  result.body = lines.slice(close + 1).join('\n').trim()
  return result
}

// Leading-integer identity for a task filename. `001-fix-login.md` → 1,
// `42-x.md` → 42. Returns null when there is no leading integer.
export function taskIdFromFilename(name) {
  if (!name) return null
  const m = String(name).match(/^(\d+)/)
  if (!m) return null
  return Number.parseInt(m[1], 10)
}

// Collect all filenames from a listing that is either a flat array of names or a
// map of directory → filename array (scanning across every directory / lane).
function collectNames(listing) {
  if (Array.isArray(listing)) return listing
  if (listing && typeof listing === 'object') {
    return Object.values(listing).flatMap((v) => (Array.isArray(v) ? v : []))
  }
  return []
}

// Next task number: max(leading-integer) + 1 across every filename in the
// listing (both lanes, all status dirs). An empty/number-less listing yields 1.
export function nextTaskNumber(listing) {
  const names = collectNames(listing)
  let max = 0
  for (const name of names) {
    const id = taskIdFromFilename(name)
    if (id != null && id > max) max = id
  }
  return max + 1
}
