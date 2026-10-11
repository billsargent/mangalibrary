# Configuration

The server reads configuration from environment variables, falling back to
`config.json` in the config directory, then to defaults.

**Precedence:** environment > `config.json` > defaults.

## Settings

| Setting            | Environment variable      | `config.json` key  | Default                       |
| ------------------ | ------------------------- | ------------------ | ----------------------------- |
| Config directory   | `KOMGA_CONFIG_DIR`        | —                  | `~/.komga`                    |
| Database file      | `KOMGA_DATABASE_FILE`     | `databaseFile`     | `<configDir>/database.sqlite` |
| HTTP port          | `SERVER_PORT` (or `PORT`) | `port`             | `25600`                       |
| Bind address       | `SERVER_HOST`             | `host`             | `0.0.0.0`                     |
| Log level          | `LOG_LEVEL`               | `logLevel`         | `info`                        |
| Session lifetime   | `KOMGA_SESSION_TTL_MS`    | —                  | `604800000` (7 days)          |
| Announcements feed | `KOMGA_ANNOUNCEMENTS_URL` | `announcementsUrl` | unset                         |
| Release notes      | `KOMGA_RELEASES_URL`      | `releasesUrl`      | unset                         |

The last two are where the server reads something hosted elsewhere from. Unset means there is
no source, and the endpoints that use them answer `404` rather than reaching out to a website
nobody asked for. See [COMPATIBILITY.md](COMPATIBILITY.md) for what they return.

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
