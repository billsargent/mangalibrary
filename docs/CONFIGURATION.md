# Configuration

The server reads its settings from three places. The first that names a setting wins:

1. **Environment variables**, for one start or for a service definition.
2. **`mangalibrary.json`, beside the program** - in the folder you cloned. This is the
   file to edit. `git pull` never touches it.
3. **`config.json` inside the data folder**, as before. It cannot say where the data
   folder is, being in it.

## The config file

Copy the example and edit it:

```bash
cp mangalibrary.example.json mangalibrary.json
```

```json
{
  "dataDir": "/srv/mangalibrary",
  "databaseFile": "/srv/mangalibrary/database.sqlite",
  "port": 25600,
  "host": "0.0.0.0",
  "logLevel": "info"
}
```

Every key is optional; leave out what you do not want to change. `dataDir` is where
everything is kept. `databaseFile` moves the database alone and is only needed when it
should not be in `dataDir`. A path that is not absolute is taken from the folder the
file is in. The other keys are the ones in the table below.

To keep the file somewhere else, name it: `MANGALIBRARY_CONFIG_FILE=/etc/mangalibrary.json`.

When it starts, the server says which data folder, database and config file it is
using. A place it cannot write to stops it with a sentence saying so.

### Moving a database that already exists

Stop the server. Move `database.sqlite` together with `database.sqlite-wal` and
`database.sqlite-shm` if they are there - they are part of it. Set `databaseFile` (or
`dataDir`, having moved the whole folder) and start again.

### Keep the database on a local disk

Your books can be on a network share. The database should not be: SQLite relies on file
locking that NFS and SMB shares do not provide reliably, and a database kept on one can
be corrupted. Put it on a disk of the machine the server runs on.

## Settings

The key is the same in `mangalibrary.json` and in `config.json`.

| Setting                   | Environment variable                | Config file key                      | Default                                |
| ------------------------- | ----------------------------------- | ------------------------------------ | -------------------------------------- |
| Config file               | `MANGALIBRARY_CONFIG_FILE`          | —                                    | `mangalibrary.json` beside the program |
| Data folder               | `MANGALIBRARY_CONFIG_DIR`           | `dataDir` (`mangalibrary.json` only) | `~/.mangalibrary`                      |
| Database file             | `MANGALIBRARY_DATABASE_FILE`        | `databaseFile`                       | `<configDir>/database.sqlite`          |
| HTTP port                 | `SERVER_PORT` (or `PORT`)           | `port`                               | `25600`                                |
| Bind address              | `SERVER_HOST`                       | `host`                               | `0.0.0.0`                              |
| Log level                 | `LOG_LEVEL`                         | `logLevel`                           | `info`                                 |
| Session lifetime          | `MANGALIBRARY_SESSION_TTL_MS`       | —                                    | `604800000` (7 days)                   |
| Announcements feed        | `MANGALIBRARY_ANNOUNCEMENTS_URL`    | `announcementsUrl`                   | unset                                  |
| Release notes             | `MANGALIBRARY_RELEASES_URL`         | `releasesUrl`                        | unset                                  |
| Fonts directory           | `MANGALIBRARY_FONTS_DIR`            | `fontsDir`                           | `<configDir>/fonts`                    |
| Cross-origin callers      | `MANGALIBRARY_CORS_ALLOWED_ORIGINS` | `corsAllowedOrigins`                 | none                                   |
| Trust a proxy's addresses | `MANGALIBRARY_TRUST_PROXY`          | `trustProxy`                         | off                                    |
| Web UI bundle             | `MANGALIBRARY_UI_DIR`               | `uiDir`                              | `ui/dist` beside the server            |
| Worker threads            | `MANGALIBRARY_WORKER_THREADS`       | `workerThreads`                      | on                                     |

## Where the data is kept

The database, `config.json` and the fonts directory live in the config directory,
`~/.mangalibrary` unless `MANGALIBRARY_CONFIG_DIR` names another.

Earlier versions used `~/.komga`, which is Komga's own directory, and named their
settings `KOMGA_*`. Both are still understood:

- The first start with no config directory named moves `~/.komga` to `~/.mangalibrary`
  when the database in it is one this server made, and says so in the log. A directory
  holding a real Komga database is recognised and left untouched. If the move cannot be
  made - another program has the directory open - the old directory goes on being used
  and the log says why.
- A setting still named `KOMGA_...` is read as before. Named both ways, the
  `MANGALIBRARY_...` one wins.

## Worker threads

Reading a book's file - listing its pages, measuring them, hashing it, taking its cover -
happens on worker threads, so a scan does not hold up the requests made beside it. How
many books are worked on at once is the _Task threads_ server setting, in the UI under
Server settings; the server will not use more threads than the machine has cores, less one.
Each thread costs memory of its own while it works and is let go after a minute idle.

`MANGALIBRARY_WORKER_THREADS=false` turns them off: the same work then runs on the main thread.

Two more threads serve pages to people who are reading: a page of a CBR is unpacked and
a page of a PDF is drawn on one of them, so that neither holds up the server and a scan
with every job thread busy does not keep a reader waiting. A book always goes to the
same one of the two, which keeps the book it last read from open for a minute; an open
PDF is its whole file in memory, so at most two are held at once. The same switch turns
these off.

## The web UI

The server serves the built web UI from its own origin, at `/`. It looks for the bundle in
`ui/dist` beside the server, which is where `npm run build:ui` leaves it; `MANGALIBRARY_UI_DIR`
names another directory. A directory with no `index.html` in it is not a bundle: the
server then starts without a UI, says so in its log, and answers the API as usual.

The UI is a single-page application, so a `GET` for a path that is neither a file in the
bundle nor part of the API (`/api`, `/sse`, `/actuator`, `/health`, `/opds`, `/kobo`,
`/koreader`) is answered with the application's page. That is what lets a reload on
`/series/...` come back to the same screen. An unknown API path still answers `404` in JSON.

The announcements feed and the release notes are where the server reads something hosted
elsewhere from. Unset means there is
no source, and the endpoints that use them answer `404` rather than reaching out to a website
nobody asked for. See [COMPATIBILITY.md](COMPATIBILITY.md) for what they return.

## Cross-origin callers

A browser refuses to call the API from a page served by another origin unless the server
allows that origin, so by default none is allowed: nothing in a Komga deployment needs CORS,
because the API and the UI are served from the same place. The exception is development,
where the UI runs on its own server (`http://localhost:3000`) and calls an API that is
elsewhere. Allowing it is a statement about who may make a browser request to this server, so
it is off unless an operator asks for it:

```bash
MANGALIBRARY_CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:4173 npm run dev
```

The value is a comma-separated list of origins (`scheme://host:port`, no trailing slash), or
an array of them in `config.json`. When it is not empty, those origins are allowed to call
any API path with credentials, and a browser may read `Content-Disposition` and `X-Auth-Token`
from the response, which is what a client needs to download a file and to pick up a session
token. The reference implementation exposes the same behaviour through
`komga.cors.allowed-origins`.

Two things to know when the halves are run apart. The UI's development server defaults to the
API on `http://localhost:8080` (`.env.development` in `ui/`), so the server has to be started
with `SERVER_PORT=8080` for the pair to line up. And a browser is left holding a session cookie
of its own: signing in again replaces one the server can no longer resolve - a dev database
cleared and seeded again, for instance - so a cookie that names a session nobody has is not
something an operator has to clean up.

## Examples

Environment:

```bash
MANGALIBRARY_CONFIG_DIR=/data/mangalibrary SERVER_PORT=8080 LOG_LEVEL=debug npm start
```

`config.json` in the config directory:

```json
{
  "port": 8080,
  "logLevel": "debug"
}
```

## Endpoints

| Path          | Purpose                                                         |
| ------------- | --------------------------------------------------------------- |
| `GET /health` | Liveness probe. Returns `{ "status": "ok", "version": "..." }`. |

## Database

SQLite via `better-sqlite3`, queried with Kysely. On open, the connection sets:

- `journal_mode = WAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`

Schema changes are applied by the migration runner at startup, recorded in the
`schema_migrations` table. Migrations are declared in `server/src/db/migrations/`
and are idempotent.

## Behind a reverse proxy

A proxy in front of the server (for HTTPS, say) tells it the client's real address
and protocol in `X-Forwarded-For` and `X-Forwarded-Proto`. Those headers are believed
only when `trustProxy` is on (`MANGALIBRARY_TRUST_PROXY=true`). Turn it on only behind
a proxy that sets them: believed from anybody, they let a client claim any address,
and with it walk around the limit on failed sign-ins (ten per account and thirty per
address in fifteen minutes). With it on behind HTTPS, the session cookies are also
marked `Secure`.
