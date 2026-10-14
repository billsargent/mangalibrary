# Agent Instructions

## Project structure

- `server`: Node/TypeScript backend (Fastify + Kysely + SQLite)
- `ui`: Vite + Vue 3 frontend (forked from Komga `next-ui`)
- `importer`: migration CLI (legacy Komga DB -> new schema)

## Tech stack

- Backend: Node.js 22 or 24 (both in CI), TypeScript, Fastify, Kysely, better-sqlite3, piscina, sharp
- Frontend: Vue 3, Vite, Vuetify, Pinia Colada, Valibot

## Quality gates

Every change must pass all quality gates:

- type checking: `npm run type-check`
- unit tests: `npm test`
- lint: `npm run lint`
- formatting: `npm run prettier`

For the UI, run the same gates inside `ui/` (`npm run type-check`, `npm run test:unit`,
`npm run lint:fix`, `npm run prettier:fix`).

## Workflow

All work is tracked as GitHub issues — see [CONTRIBUTING.md](CONTRIBUTING.md).
Document every task as an issue **when it is found**, not at the end of a session.
