# Configuration

The server reads configuration from environment variables, falling back to
`config.json` in the config directory, then to defaults.

**Precedence:** environment > `config.json` > defaults.

## Settings

| Setting              | Environment variable         | `config.json` key    | Default                       |
| -------------------- | ---------------------------- | -------------------- | ----------------------------- |
| Config directory     | `KOMGA_CONFIG_DIR`           | —                    | `~/.komga`                    |
| Database file        | `KOMGA_DATABASE_FILE`        | `databaseFile`       | `<configDir>/database.sqlite` |
| HTTP port            | `SERVER_PORT` (or `PORT`)    | `port`               | `25600`                       |
| Bind address         | `SERVER_HOST`                | `host`               | `0.0.0.0`                     |
| Log level            | `LOG_LEVEL`                  | `logLevel`           | `info`                        |
| Session lifetime     | `KOMGA_SESSION_TTL_MS`       | —                    | `604800000` (7 days)          |
| Announcements feed   | `KOMGA_ANNOUNCEMENTS_URL`    | `announcementsUrl`   | unset                         |
| Release notes        | `KOMGA_RELEASES_URL`         | `releasesUrl`        | unset                         |
| Fonts directory      | `KOMGA_FONTS_DIR`            | `fontsDir`           | `<configDir>/fonts`           |
| Cross-origin callers | `KOMGA_CORS_ALLOWED_ORIGINS` | `corsAllowedOrigins` | none                          |

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
KOMGA_CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:4173 npm start
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
KOMGA_CONFIG_DIR=/data/komga SERVER_PORT=8080 LOG_LEVEL=debug npm start
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
