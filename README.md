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

## Install and run

You need **Node.js 22 or 24** and npm, and `git` to fetch it. On Linux:

```bash
git clone https://github.com/billsargent/mangalibrary.git
cd mangalibrary
npm run install:all    # dependencies of the server, the importer and the web UI
npm run build          # builds the server and the web UI
./scripts/start.sh     # starts it, and says where it can be reached
```

`npm start` does the same as `./scripts/start.sh`, on any system. Both rebuild first if
the source is newer than what was built, so after `git pull` starting it again is all an
update takes (`npm run install:all` first if dependencies changed). The first start after
an update may upgrade the database, which on a large library can take some minutes before
it answers; it prints each step as it finishes. Let it finish.

Open the address it prints. The first visit asks you to create the administrator; then
add a library under _Libraries_ and let it scan. A large library takes a long time to
scan and analyse the first time; it can be used while that goes on.

- **From other machines.** It listens on every network address of the machine, on port 25600. Open that port in the machine's firewall (`sudo ufw allow 25600/tcp`, or your
  system's equivalent) and browse to `http://<the machine>:25600`. It speaks plain http:
  keep it to a network you trust or a VPN, or put an HTTPS proxy in front of it.
- **Settings.** Copy `mangalibrary.example.json` to `mangalibrary.json` and edit it:
  where the data goes (`dataDir`, `databaseFile`), the port, the address. `git pull`
  leaves that file alone. One start can be told differently from the environment
  (`SERVER_PORT=8080 ./scripts/start.sh`); [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
  has every setting. `LOG_LEVEL=warn` quiets
  the log, which otherwise has a line for every request.
- **Your data** is in `~/.mangalibrary` unless you say otherwise - the start script
  prints where - and is one SQLite database, `database.sqlite`, holding
  everything this server knows - users, read progress, metadata, posters. Your books
  are only ever read where they are. To back up, stop the server and copy that folder. Keep the database on a local disk,
  not a network share.
- **Node.js 22 or 24.** Both are tested on every change. The database module comes
  ready-made for the Node version it was installed under, so after switching Node -
  an upgrade, `nvm use` - run `npm run install:all` again (or
  `npm rebuild better-sqlite3 --prefix server`, and the same for `importer`). An
  install from before October 2026 crashed under Node 24 ("Assertion failed ...
  Aborted"); `git pull` and `npm run install:all` fix it.
- **Keeping it running.** The start script runs until it is stopped. To have it start
  with the machine, run it from a systemd unit or a `tmux`/`screen` session.

## Docker

```bash
docker build -t mangalibrary .
docker run -d --name mangalibrary -p 25600:25600 --restart unless-stopped \
  -v /srv/mangalibrary:/data -v /srv/manga:/books:ro mangalibrary
```

- **`/data`** holds everything the server keeps: the database, its settings, fonts. Back
  it up. An upgrade is `git pull`, `docker build` again, and a new container on the same
  `/data`.
- **`/books`** is your library, read-only unless you want the server to delete, convert
  or rename files for you. Add a library whose folder is `/books`, or one inside it.
- **Permissions.** The server runs as uid 1000. If your folders belong to someone else,
  add `--user $(id -u):$(id -g)` (and make `/srv/mangalibrary` theirs).
- **Settings** go in as environment variables (`-e LOG_LEVEL=warn`;
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md)) or in `/data/config.json`.
- **Importing from Komga**: run the importer from a checkout, with `--to` the folder you
  mount as `/data` and `--map` from Komga's folders to `/books`
  ([docs/IMPORT.md](docs/IMPORT.md)).

CI builds the image and runs the install smoke test against it on every change.

## Development

Each app (`server/`, `importer/`, `ui/`) installs its own dependencies as a
standalone package (no npm workspaces); `npm run install:all` installs all of them.

```bash
npm run dev            # the server from source, restarting when a file changes
npm run build:ui       # the web UI it serves; build it again after changing ui/
npm run smoke          # after "npm run build": install-to-reading check of the built server
```

Common commands (from the repo root):

```bash
npm run type-check     # type-check server + importer
npm test               # run server + importer unit tests
npm run lint           # lint server + importer
npm run prettier       # check formatting (npm run prettier:fix to apply)
```

All four run in CI, and so does the install, build and smoke test above, on Linux.

## Contributing

All work is tracked as GitHub issues and pull requests. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). MangaLibrary is derived from Komga (MIT).
