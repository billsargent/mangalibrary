# Compatibility

MangaLibrary deliberately makes a split between what it keeps compatible with
Komga and what it changes.

## Kept: the REST API

The HTTP API is kept compatible with Komga's published `openapi.json`:

- Same paths, verbs, query parameters and response shapes.
- Enables the `ui/` client (generated from the spec) to work unchanged.
- Lets third-party clients (Tachiyomi/Mihon, OPDS readers) work later at low cost.

Clients authenticate the same way: session cookie (`KOMGA-SESSION`), `X-Auth-Token`
header, HTTP Basic, or an API key. Passwords use bcrypt so imported users can log
in without a reset.

## Changed: storage & internals

Storage is intentionally **not** Komga's schema. Reasons:

| Komga | MangaLibrary | Why |
| --- | --- | --- |
| Flyway (88 migrations + 5 Kotlin data migrations) | Own migration runner | No JVM, simpler history |
| jOOQ-generated queries | Kysely | TypeScript-native |
| Lucene index | SQLite FTS5 | No external index; no JVM |
| Custom SQLite collations (`COLLATION_UNICODE_1/3`) | Precomputed `*_sort` columns | `better-sqlite3` can't register collations |
| Separate `tasks.sqlite` with Java class names | `jobs` table | No Java class coupling |
| Spring Session tables | `sessions` table | Simpler auth store |
| Five thumbnail tables | One `thumbnails` table | Less duplication |

## Migration

Use `importer/` to convert an existing Komga install. It reads the legacy
database read-only and writes the new schema; book files are untouched. See
[IMPORT.md](IMPORT.md).

## Not in scope (yet)

OPDS v1/v2, Kobo sync, KOReader sync, Mihon/Tachiyomi shims, OAuth2/OIDC login,
and the desktop tray app are out of the initial scope.
