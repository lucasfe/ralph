// The haystack for a PURITY spec: a module's source with its prose taken out.
//
// Several specs assert that a module reaches no clock, no environment and no
// filesystem by grepping its own source for `process`, `Date`, `Math.random` and
// `node:fs`. That only works on code — a comment is free to say "the calling
// process" — so the prose has to come out first or the spec goes red on an edit
// that changed nothing.
//
// BLOCK comments are the half that matters. The sprite modules are mostly JSDoc,
// so a filter that only dropped `//` lines would leave the docblocks in the
// haystack and make a purity assertion answerable by a paragraph. A spec that
// fails on a prose edit is a spec that gets weakened rather than heeded, which is
// the opposite of what it is for.
//
// Line comments go second, trailing ones included. The `(^|\s)` guard is what
// keeps a `//` inside a string literal ('https://…') from eating the rest of a
// real line of code.
import { readFileSync } from 'node:fs'

/**
 * Read a source file and strip every comment, leaving the code a purity spec greps.
 *
 * @param {string|URL} path the module to read — a path or an `import.meta.url` URL
 * @returns {string} the file's contents with block and line comments removed
 */
export function codeWithoutComments(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}
