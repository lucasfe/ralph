const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

export function interpolate(template, vars = {}, { stderr = process.stderr } = {}) {
  if (typeof template !== 'string') {
    throw new TypeError(
      `interpolate: template must be a string (got ${template === null ? 'null' : typeof template})`,
    )
  }
  const warned = new Set()
  return template.replace(PLACEHOLDER, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = vars[key]
      return value == null ? '' : String(value)
    }
    if (!warned.has(key)) {
      warned.add(key)
      stderr.write(`⚠️  interpolate: unknown placeholder {{${key}}} — left intact\n`)
    }
    return match
  })
}
