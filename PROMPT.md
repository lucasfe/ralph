# Project context for Ralph

## Stack

React 19 + Vite + Tailwind CSS 4. Plain JavaScript (no TypeScript).
Components in `src/components/`, static data in `src/data/`. Tests via
Vitest. The Ralph package itself lives in `packages/ralph/` and has its
own test suite (`cd packages/ralph && npm test`).

## MCPs

- `mcp__supabase__*` — Supabase project access. Use when an issue
  involves database, schema, queries, or edge functions in `supabase/`.
- If an MCP call returns an auth error, do NOT try to re-authenticate
  (it requires human interaction). Use `gh`, local code, and Read/Edit
  tools instead.

## Sub-agents / slash commands

- `/project:manager` — orchestrate, plan, delegate
- `/project:frontend` — React components, Tailwind, routing
- `/project:backend` — APIs, database, auth
- `/project:qa` — review, tests, accessibility
- `/project:docs` — CLAUDE.md, README, JSDoc
- `/project:gitops` — branches, commits, PRs, CI/CD

## Extra restrictions

- Do not modify files under `packages/ralph/` unless the issue is
  explicitly about the Ralph package — they are part of a separately
  versioned npm package.
