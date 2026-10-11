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

| Komga                                              | MangaLibrary                 | Why                                        |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| Flyway (88 migrations + 5 Kotlin data migrations)  | Own migration runner         | No JVM, simpler history                    |
| jOOQ-generated queries                             | Kysely                       | TypeScript-native                          |
| Lucene index                                       | SQLite FTS5                  | No external index; no JVM                  |
| Custom SQLite collations (`COLLATION_UNICODE_1/3`) | Precomputed `*_sort` columns | `better-sqlite3` can't register collations |
| Separate `tasks.sqlite` with Java class names      | `jobs` table                 | No Java class coupling                     |
| Spring Session tables                              | `sessions` table             | Simpler auth store                         |
| Five thumbnail tables                              | One `thumbnails` table       | Less duplication                           |

## Migration

Use `importer/` to convert an existing Komga install. It reads the legacy
database read-only and writes the new schema; book files are untouched. See
[IMPORT.md](IMPORT.md).

## Documented differences

A few behaviours cannot be reproduced exactly, or are deliberately defined where
Komga leaves room for interpretation. Clients see the same shape either way.

| Endpoint                                                                                            | Difference                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any list with an `unpaged=true` parameter                                                           | The response is a single page whose `size` equals the number of elements, matching Spring's unpaged `PageImpl`.                                                                                                                                                                                                                                                                      |
| `GET /api/v1/series/latest`                                                                         | Ordered by the creation time of the series' most recently added book, so a series reappears when new volumes arrive.                                                                                                                                                                                                                                                                 |
| `GET /api/v1/series/new`                                                                            | Ordered by when the series itself was created.                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/v1/series/updated`                                                                        | Ordered by `lastModified` of the series.                                                                                                                                                                                                                                                                                                                                             |
| `deleted` parameter                                                                                 | Defaults to excluding deleted items, as Komga does. `oneshot` and `unpaged` constrain nothing until a client sets them explicitly.                                                                                                                                                                                                                                                   |
| `age_rating` filter                                                                                 | `-1` selects series with no age rating, since an unset rating is a null column rather than a sentinel.                                                                                                                                                                                                                                                                               |
| List-valued metadata (`tags`, `genres`, `links`, `authors`, `alternateTitles`, `sharingLabels`)     | Returned in a deterministic order (alphabetical by label). The database has no inherent ordering for these rows, and a stable order keeps clients and tests predictable.                                                                                                                                                                                                             |
| `POST .../list` request bodies                                                                      | The `condition` object (Komga's structured search language) and the FTS5 index arrive with the search work; `fullTextSearch` is honoured today.                                                                                                                                                                                                                                      |
| `SeriesDto.booksMetadata.summaryNumber`                                                             | Present but empty: the schema does not record which book's metadata won the aggregation.                                                                                                                                                                                                                                                                                             |
| `MediaDto.epubDivinaCompatible`                                                                     | Always `false` until the analysis job inspects archives and EPUBs.                                                                                                                                                                                                                                                                                                                   |
| `CollectionDto.filtered` / `ReadListDto.filtered`                                                   | Always `false`: saved searches (dynamic collections and read lists) are not modelled; the id lists are authoritative.                                                                                                                                                                                                                                                                |
| Collections and read lists                                                                          | Global resources, and visibility is derived from their members: one is listed when at least one member is visible, and `seriesIds` / `bookIds` is trimmed to what the caller may see. An empty collection is therefore visible only to an admin.                                                                                                                                     |
| `POST /collections` and `POST /readlists`                                                           | Return `200` with the created DTO, as the spec documents, and create the resource immediately. `PATCH` replaces `seriesIds` / `bookIds` wholesale and sets their order.                                                                                                                                                                                                              |
| `POST /readlists/match/comicrack`                                                                   | Matches only: it creates nothing and stores nothing, leaving the client to confirm and then create the read list. Series are matched on title (or name) ignoring case, then books on number; unmatched entries come back with an empty `matches` array. Reading lists are parsed directly rather than by taking on an XML dependency, since a `.cbl` is a fixed, tiny subset of XML. |
| `PATCH .../metadata`                                                                                | Writes the fields present in the body and records the requested lock state. A lock does not block a PATCH - it stops scanning and metadata refresh from overwriting a hand-edited field. Non-nullable columns (`title`, `summary`, ...) cannot be unset, so an explicit null is ignored for them.                                                                                    |
| `GET /{books\|series\|collections\|readlists}/{id}/thumbnail`                                       | Serves the selected thumbnail, falling back to the newest one when nothing is selected, and `404` when the item has no artwork at all. Komga generates a poster from the first page in that last case; ours arrives with the media layer (M6a, #32). Responses carry an `ETag` and `Cache-Control`, and answer `304` on a matching `If-None-Match`.                                  |
| `POST .../thumbnails`                                                                               | The uploaded poster becomes the selected one, and the previously selected thumbnail is deselected. The upload must be a raster image: SVG is rejected rather than stored, because it is a document format that can carry script.                                                                                                                                                     |
| `GET /api/v1/books/{id}/file`                                                                       | Sends the file as an attachment with `Content-Type` taken from its extension, and a `Last-Modified` header. A book whose file is missing from disk answers `404`, not a zero-length body.                                                                                                                                                                                            |
| `DELETE /api/v1/books/{id}/file`, `DELETE /api/v1/series/{id}/file`, `PUT /api/v1/books/thumbnails` | Answer `202` and queue a job; the file and poster work itself belongs to the scanning layer (M6), which also has to keep the trash and the database in step.                                                                                                                                                                                                                         |

## Scanning

How a library directory is read - which directory becomes a series, how
exclusions match, what a oneshots folder does, and what happens to files that
disappear - is specified in [SCANNING.md](SCANNING.md). It records Komga's
behaviour rule by rule, and the two places we are deliberately stricter.

## Not in scope (yet)

OPDS v1/v2, Kobo sync, KOReader sync, Mihon/Tachiyomi shims, OAuth2/OIDC login,
and the desktop tray app are out of the initial scope.
