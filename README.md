# MangaLibrary

A media server for your comics, mangas, BDs, magazines and eBooks — a **Java-free,
TypeScript rewrite of [Komga](https://github.com/gotson/komga)**.

## What this is

MangaLibrary replaces Komga's Kotlin / Spring Boot backend with a Node.js +
TypeScript server, while **keeping the same REST API**, so the Komga web UI
(and existing clients) keep working. Storage is a modern SQLite schema; existing
Komga databases are migrated with the bundled importer.

## Layout

| Path | What it is |
| --- | --- |
| `server/` | Fastify + Kysely + SQLite backend (the API server) |
| `ui/` | Vite + Vue 3 + Vuetify frontend (forked from Komga's `next-ui`) |
| `importer/` | `komga-import` CLI — reads a legacy `~/.komga` and writes the new database |
| `docs/` | Architecture, compatibility notes and import guide |

## Compatibility policy

- **REST API** — kept compatible with Komga's `openapi.json` so the UI and
  third-party clients keep working.
- **Storage** — intentionally different (cleaner schema, FTS5 search, no Lucene /
  Flyway / custom collations). Use `importer/` to migrate existing data.

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the full policy.

## Development

Requirements: **Node.js >= 22** and npm.

The server and importer are npm workspaces at the repo root; the UI is a
standalone Vite app.

```bash
npm install            # server + importer workspaces
npm install -w ui      # (from repo root) or: cd ui && npm install
```

Common commands:

```bash
npm run type-check     # type-check all workspaces
npm test               # run unit tests
npm run lint           # lint all workspaces
```

## Contributing

All work is tracked as GitHub issues and pull requests. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). MangaLibrary is derived from Komga (MIT).
