# Architecture

MangaLibrary is a Java-free, TypeScript rewrite of Komga. It keeps Komga's REST
API but replaces everything behind it.

## Components

| Component | Path        | Responsibility                                       |
| --------- | ----------- | ---------------------------------------------------- |
| Server    | `server/`   | HTTP API, auth, domain logic, scanning, jobs, search |
| UI        | `ui/`       | Web client (forked from Komga `next-ui`)             |
| Importer  | `importer/` | One-time migration from a legacy Komga database      |

## Server stack

| Concern    | Choice                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| Runtime    | Node.js >= 22                                                             |
| HTTP       | Fastify 5 (+ cookie, session, multipart, static, cors, helmet, etag, SSE) |
| Contract   | Komga `openapi.json` -> route schemas + types at build time               |
| Database   | SQLite via `better-sqlite3`, queried with Kysely                          |
| Migrations | Own runner + `schema_migrations` table                                    |
| IDs        | TSID (13-char Crockford Base32, time-sortable)                            |
| Jobs       | `jobs` table, run in-process by a worker with a configurable pool size    |
| Events     | `EventEmitter` -> SSE + search reindex                                    |
| Search     | SQLite FTS5 (`bm25` relevance)                                            |
| Images     | `sharp`                                                                   |
| Archives   | `yauzl` (cbz), `node-unrar-js` (cbr), 7z (cb7)                            |
| EPUB / PDF | `mupdf` for PDF; EPUB packages are read with targeted patterns            |
| Auth       | Session cookie, `X-Auth-Token`, Basic, API key, remember-me; bcrypt       |
| Logging    | `pino`                                                                    |

## Data model

A clean, normalised SQLite schema (see `docs/COMPATIBILITY.md` for why it is not
Komga's schema). Key groups:

- Identity: `users`, `user_library_sharing`, `user_api_keys`,
  `authentication_activity`, `sessions`
- Library: `libraries`, `library_exclusions`
- Content: `series` + `series_metadata` (+per-field locks) + related tables;
  `books` + `book_metadata` (+locks) + related tables; `book_metadata_aggregation`
- Media: `media`, `media_page`, `media_file`, `media_container`, `epub_toc`,
  `epub_positions`
- `thumbnails` (unified, replacing Komga's five thumbnail tables): one row per
  stored poster, generated or uploaded. A series, collection or read list cover
  that has none of its own is built when it is asked for - from one of its books,
  or as a mosaic of four - and is not stored.
- Progress / organisation: `read_progress`, `read_progress_series`, `collections`,
  `collection_series`, `readlists`, `readlist_book`, `readlist_request`
- Maintenance: `page_hash` + `page_hash_thumbnail` (a page's hash lives on
  `media_page.file_hash`; an unknown hash is one nobody has judged, which is a join
  between the two), `historical_events`, `jobs`, settings tables,
  `sync_points*`
- Search: FTS5 tables `fts_books`, `fts_series`, `fts_collections`,
  `fts_readlists`, `fts_authors`

## Request flow

```text
UI / client
  -> Fastify route (schema-validated)
    -> auth (session | basic | api key) + access checks
      -> domain service
        -> Kysely repository -> SQLite
        -> jobs table (async work) -> in-process worker
        -> EventEmitter -> SSE stream + search reindex
```
