# MangaLibrary

A media server for your comics, mangas, BDs, magazines and eBooks — a **Java-free,
TypeScript rewrite of [Komga](https://github.com/gotson/komga)**.

## What this is

MangaLibrary replaces Komga's Kotlin / Spring Boot backend with a Node.js +
TypeScript server, while **keeping the same REST API**, so the Komga web UI
(and existing clients) keep working. Storage is a modern SQLite schema; existing
Komga databases are migrated with the bundled importer.

## Layout

| Path        | What it is                                                                 |
| ----------- | -------------------------------------------------------------------------- |
| `server/`   | Fastify + Kysely + SQLite backend (the API server)                         |
| `ui/`       | Vite + Vue 3 + Vuetify frontend (forked from Komga's `next-ui`)            |
| `importer/` | `komga-import` CLI — reads a legacy `~/.komga` and writes the new database |
| `docs/`     | Architecture, compatibility notes and import guide                         |

## Compatibility policy

- **REST API** — kept compatible with Komga's `openapi.json` so the UI and
  third-party clients keep working.
- **Storage** — intentionally different (cleaner schema, FTS5 search, no Lucene /
  Flyway / custom collations). Use `importer/` to migrate existing data.

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the full policy.

## Development

Requirements: **Node.js >= 22** and npm.

Each app (`server/`, `importer/`, `ui/`) installs its own dependencies as a
standalone package (no npm workspaces).

```bash
npm run install:all    # installs the root tooling, server/ and importer/
cd ui && npm install   # UI (separate Vite app)
```

Common commands (from the repo root):

```bash
npm run type-check     # type-check server + importer
npm test               # run server + importer unit tests
npm run lint           # lint server + importer
npm run prettier       # check formatting (npm run prettier:fix to apply)
```

All four run in CI.

## Contributing

All work is tracked as GitHub issues and pull requests. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). MangaLibrary is derived from Komga (MIT).
