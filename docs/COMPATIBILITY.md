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

| Endpoint                                                                                            | Difference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any list with an `unpaged=true` parameter                                                           | The response is a single page whose `size` equals the number of elements, matching Spring's unpaged `PageImpl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/v1/series/latest`                                                                         | Ordered by the creation time of the series' most recently added book, so a series reappears when new volumes arrive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/v1/series/new`                                                                            | Ordered by when the series itself was created.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/v1/series/updated`                                                                        | Ordered by `lastModified` of the series.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `deleted` parameter                                                                                 | Defaults to excluding deleted items, as Komga does. `oneshot` and `unpaged` constrain nothing until a client sets them explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `age_rating` filter                                                                                 | `-1` selects series with no age rating, since an unset rating is a null column rather than a sentinel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| List-valued metadata (`tags`, `genres`, `links`, `authors`, `alternateTitles`, `sharingLabels`)     | Returned in a deterministic order (alphabetical by label). The database has no inherent ordering for these rows, and a stable order keeps clients and tests predictable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST .../list request bodies                                                                        | condition and ullTextSearch both work: the first as the structured search language, the second as a full-text search over the FTS5 index. Both are described in [Search conditions](#search-conditions) and [Full-text search](#full-text-search).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MediaDto.epubDivinaCompatible`                                                                     | Always `false` until the analysis job inspects archives and EPUBs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CollectionDto.filtered` / `ReadListDto.filtered`                                                   | Always `false`: saved searches (dynamic collections and read lists) are not modelled; the id lists are authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Collections and read lists                                                                          | Global resources, and visibility is derived from their members: one is listed when at least one member is visible, and `seriesIds` / `bookIds` is trimmed to what the caller may see. An empty collection is therefore visible only to an admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /collections` and `POST /readlists`                                                           | Return `200` with the created DTO, as the spec documents, and create the resource immediately. `PATCH` replaces `seriesIds` / `bookIds` wholesale and sets their order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /readlists/match/comicrack`                                                                   | Matches only: it creates nothing and stores nothing, leaving the client to confirm and then create the read list. Series are matched on title (or name) ignoring case, then books on number; unmatched entries come back with an empty `matches` array. Reading lists are parsed directly rather than by taking on an XML dependency, since a `.cbl` is a fixed, tiny subset of XML.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PATCH .../metadata`                                                                                | Writes the fields present in the body and records the requested lock state. A lock does not block a PATCH - it stops scanning and metadata refresh from overwriting a hand-edited field. Non-nullable columns (`title`, `summary`, ...) cannot be unset, so an explicit null is ignored for them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /{books\|series\|collections\|readlists}/{id}/thumbnail`                                       | Serves the selected thumbnail, falling back to the newest one when nothing is selected, and `404` when the item has no artwork at all. Komga generates a poster from the first page in that last case; ours arrives with the media layer (M6a, #32). Responses carry an `ETag` and `Cache-Control`, and answer `304` on a matching `If-None-Match`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST .../thumbnails`                                                                               | The uploaded poster becomes the selected one, and the previously selected thumbnail is deselected. The upload must be a raster image: SVG is rejected rather than stored, because it is a document format that can carry script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/v1/books/{id}/file`                                                                       | Sends the file as an attachment with `Content-Type` taken from its extension, and a `Last-Modified` header. A book whose file is missing from disk answers `404`, not a zero-length body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/v1/books/{id}/pages/{pageNumber}`                                                         | The image of one page, for a book this server can render one for: a ZIP or RAR of images, or a PDF, which is rendered to PNG. `zero_based` shifts the page number and `convert=jpeg\|png` re-encodes the image; any other `convert` value is `400`. The response is an inline attachment named after the book and page, with `Last-Modified` and `304` revalidation. A book that is not analysed, or whose type cannot be rendered as an image, is `404`; a page outside the list is `400`. Two deliberate differences: the reference's PDF content negotiation (a raw PDF page when `Accept` prefers `application/pdf`) is not implemented, and a page of a text EPUB answers `404` here, where the reference fails with a server error.                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/v1/books/{id}/pages/{pageNumber}/thumbnail`                                               | The same page, resized to fit 300px on its longest edge and always served as JPEG. A JPEG that already fits is returned unchanged, as the reference does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/v1/books/{id}/manifest`, `.../manifest/{divina,epub,pdf}`                                 | The WebPub manifest of a book: `/manifest` picks the profile that fits the book, and a named one asks for that profile explicitly (`400` when the book's media type does not match, except `divina`, which the reference offers for any book). Metadata, the `self`, `acquisition` and poster links, and the reading order are built the way the reference builds them. Three deliberate differences: the PDF reading order points at the rendered page image (`pages/{n}`) rather than the raw PDF page (`pages/{n}/raw`), which this server cannot extract; EPUB `landmarks` and `pageList` are empty because analysis does not read them, and `rendition` is omitted; and a Divina-compatible EPUB is recognised from its pages all being images rather than from a stored flag.                                                                                                                                                                                                                                                                                                 |
| `GET /api/v1/books/{id}/resource/{resource}`                                                        | A file from inside an EPUB, addressed by its path within the book, which is how the reader loads a book's own stylesheets, images and text. A font (`otf`, `woff`, `woff2`, `eot`, `ttf`, `svg`) is served without credentials, because the reader fetches it from inside a book where it has no session to send; anything else requires one, and is confined by the caller's access to the book. The response carries the file's media type by extension, an inline name, `Content-Security-Policy: script-src 'none'; object-src 'none';`, and `Last-Modified` with `304` revalidation. Only an EPUB has resources; another media type answers `400`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/v1/series/{id}/file`, `GET /api/v1/readlists/{id}/file`                                   | Downloads the whole series or read list as a ZIP, one entry per book file. A series names its entries after the files; a read list numbers them in list order (`1 - file.cbz`). A book whose file is no longer on disk is skipped rather than failing the download. The archive is written as it is sent, with zip64 always on and entries stored rather than compressed - a book file is already compressed, and the reference sets its deflate level to no compression too. `FILE_DOWNLOAD` is required, and a series or read list the caller cannot see is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/v1/books/{id}/file/*`                                                                     | The same download as `books/{id}/file`, with any file name a client chooses appended to the path; the appended part is ignored and the book's own file is sent, as the reference does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/v1/books/{id}/pages/{pageNumber}/raw`                                                     | Not implemented: the reference serves a raw PDF page here, which this server's PDF reader cannot extract, so the path answers `404`. The PDF manifest's reading order points at the rendered page image instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DELETE /api/v1/books/{id}/file`, `DELETE /api/v1/series/{id}/file`, `PUT /api/v1/books/thumbnails` | Answer `202` and queue a job; the file and poster work itself belongs to the scanning layer (M6), which also has to keep the trash and the database in step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/v1/settings`                                                                              | An admin sees every setting, anyone else only `maxUploadFileSizeBytes`, as documented. `serverPort` carries the value the configuration asked for and the port actually in use; `serverContextPath` is always `null` (see below); `kepubifyPath` reports the stored value, since there is no converter to read a location from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PATCH /api/v1/settings`                                                                            | The same fields, except that a non-empty `serverContextPath` is refused with `400` instead of stored. This server always answers at the root, so accepting a context path would leave every client calling paths that do not exist. `renewRememberMeKey` invalidates cookies signed with the old key immediately, without waiting for a restart. `thumbnailSize` is validated and stored but does not change generated artwork yet, which arrives with the media layer (#32); the Kobo settings are stored for clients that set them, while Kobo sync itself is out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/v1/client-settings/global/list`                                                           | Without credentials the response holds only the settings marked `allowUnauthorized`, as documented. Values are stored as text, exactly as they were sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PATCH` / `DELETE /api/v1/client-settings/{global,user}`                                            | Keys must match the documented lowercase namespaced pattern; anything else is refused with `400` rather than stored. Global settings are admin-only, user settings belong to the caller. Deleting a key that is not there is not an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET` / `POST /api/v1/claim`                                                                        | Open on purpose, and closed by state: the claim is "does any user exist", so the first account can be created without credentials and every later attempt is refused with `400`. Credentials are read from the `X-Komga-Email` and `X-Komga-Password` headers as the spec requires, the email must look like an address, and the account gets every role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /actuator/info`                                                                                | Same untyped map of facts about the running server, filled from the Node process: `build`, `runtime` and `os`. The JVM-specific keys of the reference implementation (`java`, `git`) are absent rather than faked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/v1/login` with remember-me                                                               | The cookie's lifetime follows the `rememberMeDurationDays` setting instead of a fixed year.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/v1/history`                                                                               | Admin-only, newest first, with `id` appended as a tiebreaker so paging stays stable when a scan writes several events in the same millisecond. `properties` is the stored JSON object; `bookId` and `seriesId` are omitted when they are null rather than sent as null, as the reference does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DELETE /api/v1/tasks`                                                                              | Answers with the number of queued jobs removed, as documented. Queued work has no owner, so this empties the queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DELETE /api/v1/syncpoints/me`                                                                      | Removes the caller's sync points together with the books and read lists hanging off them, in one transaction. `key_id` may be repeated to narrow it, or left out to remove all of them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/v1/filesystem`                                                                           | Admin-only, and reports the drives of a Windows host or `/` elsewhere when no path is given, with `parent` left out of that answer. A path must be absolute, and a path pointing at a file lists the directory holding it, as the reference does. Entries whose name starts with a dot are hidden; a Windows file that only carries the hidden attribute is still listed, because Node does not expose that attribute. A drive letter with nothing on it is left out, and one that does not answer within a moment is listed anyway: a mapped network drive whose host is away blocks for twenty seconds and more when it is checked, so waiting on it would be a hung request rather than a slow one. Where the reference asks Java for the drives without touching them, this asks each letter and does not wait for an answer that is not coming.                                                                                                                                                                                                                                |
| `POST /api/v2/users`                                                                                | `roles` is required and must be an array, as the contract says. An unknown role name inside it is refused with `400`, naming the value: a client that asks for a permission this server does not know is better told than handed an account with less of it than it asked for. `USER` is the one exception, accepted and dropped, because every user is reported with it and a client that reads a user and writes it back must not be refused for echoing what it was told (see _Roles_). A request that says nothing about libraries gives the new user every library, because that is the reference's default: the field arrived after the endpoint existed, and defaulting to none would quietly take access away.                                                                                                                                                                                                                                                                                                                                                              |
| `PATCH`, `DELETE /api/v2/users/{id}`                                                                | Both refuse the caller's own account with `403`, as the reference does. An admin who could change their own roles here, or delete themselves, could leave an instance nobody can administer; the `me` routes are how an account changes itself. A named library that does not exist is not shared, rather than stored as a share nobody can see.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Roles                                                                                               | `ADMIN` satisfies every gate and is what the admin routes require (`/api/v2/users`, `/api/v1/settings`, `/api/v1/client-settings/global`, `/api/v1/history`, `DELETE /api/v1/tasks`, `/api/v1/filesystem`, `/api/v1/transient-books`, `/api/v1/announcements`, `/api/v1/releases`, `POST /api/v1/claim` before the instance is claimed, and the library and artwork writes). `PAGE_STREAMING` gates the pages of a book, `FILE_DOWNLOAD` the book file itself. `KOBO_SYNC` and `KOREADER_SYNC` exist in the role list and are stored, but gate nothing yet, because those endpoint families are out of scope for now. `USER` is reported on every account's DTO and is never stored: it is the reference's way of saying an account may use the server at all, added when the user is serialised rather than kept as a row, and gating nothing, because every authenticated caller has it. A client that reads it - the reference's own UI gates its library pages on it - finds it on every account, which is what stops a signed-in user from being told they may browse nothing. |
| `GET /api/v1/releases`                                                                              | Admin-only. Where the reference reads its own repository's releases, this reads whatever `releasesUrl` points at, in the same shape (GitHub's release objects), and maps them to the documented DTO with the newest first marked `latest`. With no source configured it answers `404`, as it does when the source cannot be read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/v1/announcements`                                                                         | Admin-only. The feed at `announcementsUrl` is passed through as it came, with one addition: a `_komga.read` flag per item, which is the only thing this server knows that the feed does not. Items without an id are dropped, because they could never be marked read. A configured URL that does not answer with a JSON feed, or cannot be reached, is reported as `404` - a wrong feed is a configuration mistake, not something to hand to a client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PUT /api/v1/announcements`                                                                         | Admin-only, and it replaces the caller's read set with what is sent rather than adding to it, so an empty list marks everything unread again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/v1/announcements`, `GET /api/v1/releases` (caching)                                       | Both remember what they fetched for an hour, so a browser panel that is opened repeatedly does not become repeated outbound requests. The cache belongs to the server instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/v1/fonts/families`                                                                        | Requires authentication, as it does in the reference. A family is a directory under the fonts directory (`MANGALIBRARY_FONTS_DIR`, default `<configDir>/fonts`) and its faces are the font files inside it; a directory with no font in it is not a family. The directory is read per request rather than once at startup, so dropping a font in does not need a restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/v1/fonts/resource/{fontFamily}/{fontFile}`, `.../css`                                     | Both are served without credentials, because the reader loads them from inside a book where it has no session to send - which is what the reference does with them. The CSS describes every face of the family as an `@font-face` block with the weight and style read from the file name (`Bold`, `Italic`), as the reference reads them. A family name, a file name or a path that does not resolve inside the fonts directory is `404`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /sse/v1/events`                                                                                | The event stream, authenticated, `text/event-stream`, kept alive with a comment every 15 seconds. The queue depth is pushed to administrators when they connect and every 10 seconds after that. This path is not in the published OpenAPI document, so this row is its description. Events are filtered per connection: an administrative event reaches administrators only, and an event about a user reaches that user only, so a route publishes once and nobody learns more than they may. Published today: `ReadProgressChanged`, `ReadProgressDeleted`, `ReadProgressSeriesChanged`, `ReadProgressSeriesDeleted`, the `Thumbnail*Added` and `Thumbnail*Deleted` pairs for books, series, collections and read lists, `SessionExpired` and `TaskQueueStatus`. A session ends when an admin changes what a user may see or do, when an admin resets another user's password, and when a user is deleted; an update that changes nothing readable leaves the sessions alone. The library, series, book, collection and read list change events are still to come (#23).         |
| `GET /api/v1/books/{id}/positions`                                                                  | The Readium positions analysis recorded for an EPUB: one every 1024 bytes of each resource, the first of a resource carrying the reference's Kobo span, and a resource shorter than one step still getting a single position. A book that is not an EPUB has none. One deliberate difference: a fixed-layout EPUB gets the same byte-based positions rather than one per page, because analysis does not detect fixed layout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/v1/transient-books`, `POST /api/v1/transient-books/{id}/analyze`                         | Admin-only, and nothing is written to the database: a transient book is held in memory and forgotten an hour after it was last read, as the reference does with its cache, so a restart clears an import that was never completed. A folder inside an existing library is refused with `400` and the code `ERR_1017`, and one that cannot be read with `400` and `ERR_1016`, as the reference reports them. A symlink that resolves outside the scanned folder is skipped, the same guard the file download endpoint uses. `number` and `seriesId` are always `null`: they come from the metadata readers, which run at the end of a book's analysis and not during transient scanning.                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/v1/transient-books/{id}/pages/{pageNumber}`                                               | Serves the page image with its container's media type, plus `Last-Modified` and `Cache-Control: max-age=0, private, must-revalidate`, and answers `304` on a matching `If-Modified-Since`. A book that has not been analysed, or whose analysis failed, answers `404`; a page number outside the list answers `400`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Metadata

What a book carries in its own file is read into the metadata tables when the book
is analysed. Like the EPUB reader and the ComicRack list, this is done with
targeted patterns rather than an XML parser - the documents involved are a flat
list of elements whose text is wanted.

Two documents are read: a `ComicInfo.xml` in any container, which a comic collection
usually carries, and an EPUB's package document. From the first come the book's
title, summary, number, release date, credits, tags, links and ISBN, and the series
it belongs to; from the second the same, plus the publisher, the language, the
subjects as genres, the reading direction stated on the spine, and the collection the
book belongs to - with its position in that collection as the book's number.

A series also has a file of its own in a Mylar library: a `series.json` sidecar in
its folder, from which come the name (with the year appended once the collection has
more than one volume), the publisher, the description, the status, the number of
issues in the run and the age rating. A oneshot series - one file, in a oneshots
folder - is described by its single book instead: its title, its summary, a status of
`ENDED` and a book count of 1, whatever the library's settings say, as the reference
does. The sidecar is not read for a oneshot series, and a document that cannot be
read contributes nothing rather than failing the series.

The organisation a document describes is applied as well: a `StoryArc` or an
`AlternateSeries` puts the book in a read list of that name, created when it does not
exist yet, at the place the document states when that place is free and at the end
otherwise; a `SeriesGroup` puts the series in the collections it names. These are
organisation rather than fields, so a locked title does not stop them, and nothing is
ever taken _out_ of a read list or a collection by a document - a list a user has
curated is theirs. The library settings (`importComicInfoReadList`,
`importComicInfoCollection`) turn each of them off.

When a book carries both documents, both are applied, the package document last,
which is the order the reference's providers run in.

An ISBN is also read from a barcode: an EAN-13 printed on a page - the back cover,
or inside the front - is decoded with the same library the reference uses, and the
last three pages and the first three are looked at, the back ones first, as the
reference looks at them. A reflowable EPUB is skipped, because none of its pages is
an image. Only EAN-13 is looked for, and what is decoded still has to be a valid
ISBN. The library setting `importBarcodeIsbn` turns the reading off per library, and
a locked `isbn` field is never written.

A series has no file of its own, so its metadata is folded out of its books: the
value most of them agree on, the highest age rating, the union of the genres, and
the volume appended to the title when the library asks for it (`Series (2)`; volume
1 is the series itself, so it is left alone). `SeriesDto.booksMetadata` is computed
the same way the reference computes it - the union of the credits and tags, the
earliest release date, and the summary of the earliest-numbered book that has one,
with that book's number.

Deliberate differences from the reference:

- `ComicInfo.xml` is found wherever it sits in the archive, and however it is
  capitalised; the reference insists on that exact name at the root of the
  archive.
- A value that is present but unusable is dropped on its own: a `Web` entry that
  is not a URL, a `GTIN` whose check digit does not hold, a release date the
  calendar does not have. In the reference a release date that `LocalDate` refuses
  costs the whole document, because its provider throws and returns nothing.
- An EPUB's description is stored as the words it carries with its markup removed,
  and a `dc:date` that is a timestamp keeps its date part. The reference reads the
  two the same way, but a description written as escaped text rather than as markup
  keeps its angle brackets there, and an ISBN is only recognised behind an `isbn:`
  prefix - `urn:isbn:` is understood here as well.
- A language is checked for the shape of a BCP47 tag rather than against ICU's list
  of ISO languages, and its casing is normalised (`pt_br` becomes `pt-BR`). An
  invented language therefore lands in the field, where the reference would refuse
  it; `Unknown`, which documents write, is refused by both.
- An age rating is the highest one among the books, and genres are the union of
  theirs, as the reference aggregates them. When the books disagree on a value and
  the counts tie, the earliest book in reading order wins; the reference leaves that
  to whatever order its database returned.
- A field is written only when its value would change, so re-analysing a book
  leaves the metadata rows - and their timestamps - alone.
- Reading a book's metadata is part of analysing it here, where the reference
  schedules it as its own task. The effect is the same; the book is read once
  more, which is cheaper than threading an open container through both steps.
- A series' documents are read when a scan touches the series. The reference also
  re-reads them every time one of its books' metadata is refreshed, but its task
  queue collapses those requests into one per series, and without that queue the
  same behaviour would re-read every book of a series once per book analysed. What
  analysis does here is recompute `booksMetadata` from the books' stored metadata,
  which is cheap and is what makes that view move when a book is edited or a
  document is imported.
- A changed sidecar is noticed because the folder holding it changed, which the walk
  already compares; the reference also keeps a table of sidecar files it has seen,
  which is what its own change detection reads.
- The ISBN barcode is read before the documents are, so an ISBN a document states
  wins over one read off a printed page: a document is the more specific statement of
  the two. Where two providers disagree, the reference's answer is whatever order
  Spring hands its beans in, which is not something worth copying.

## Local artwork

A cover that was never put in the archive is picked up from beside the book. For a
book, files in its folder whose name is the book's own, with an optional `-1`, `-2`
suffix - `Volume 1.jpg`, `Volume 1-1.jpg` - and an extension the reference accepts
(`png`, `jpeg`, `jpg`, `tbn`, `webp`, `gif`); for a series, the files in its folder
named `cover`, `default`, `folder`, `poster` or `series` with one of those
extensions. The first file is the one that is chosen, unless the owner already has
artwork of its own that the user picked - an upload, or another sidecar selected by
hand - which a local cover never displaces. A generated poster does not count as a
choice, so a cover beside a book takes its place.

The file itself is not copied into the database: the thumbnail row holds the file's
path and is read when the image is asked for, which is how the reference stores it
too, and why replacing a 10 MB cover costs nothing. The library setting
`importLocalArtwork` turns the whole thing off, and a oneshot series is never given
a cover from its folder - its "folder" is the library root, where a stray
`cover.jpg` belongs to no series in particular. Deleting a book's file deletes the
artwork that was found beside it, as the reference does.

Deliberate differences:

- The files are sorted by name, ignoring case, and the first is the chosen one; the
  reference takes whatever order the directory listing gives it, which is not
  defined. A cover that has changed under the same name is noticed because its row is
  written again.
- A file's type is taken from its content rather than its name, so a `.tbn` or a
  `.jpg` that is really a PNG is served as what it is. The reference detects the
  type from the file's content as well, but through Tika.
- A cover is looked for when a book is analysed, and when a book, a series or a
  library is asked to refresh its metadata; a series' folder is also looked in
  whenever a scan touches that series. The reference notices every change to a cover
  file through its sidecar table's modified times, so a cover rewritten in place
  under the same name is picked up here only when the book is analysed or refreshed
  again, and not by a scan alone.

The per-field locks (`titleLock`, `authorsLock`, and the rest) are honoured
exactly as the reference honours them, for a book and for a series: a locked field,
and a locked list, is left as the user set it. Lists are replaced rather than
merged, because the file is read as a whole, and are compared as sets so that
re-ordering credits in a file does not rewrite the book.

## Jobs

Background work - a scan, an analysis, a metadata refresh, emptying the trash,
deleting a file - is queued by the API as a row in `jobs` and run by the worker the
server starts with itself. The reference keeps its tasks in a `tasks.sqlite` file and
hands them to a Spring thread pool.

What is the same: a job is claimed while it runs, so two workers never take the same
one; jobs sharing a group never run at the same time, which is how a series' books
are analysed in order; a job is keyed by a unique key, so asking twice for the same
work replaces what was queued; the most important job goes first and, among equals,
the one that waited longest; the pool size is the `TASK_POOL_SIZE` setting; and a
library with `scanOnStartup` is scanned when the server comes up.

Deliberate differences:

- The queue is polled every half second rather than pushed to: work queued while
  nothing runs is picked up by the next tick. A job that finishes hands its place to
  the next one at once, and a queue that is briefly unreadable does not stop the
  worker.
- A job that fails is logged with its error and dropped, as the reference drops it,
  so a broken library does not wedge the queue. Nothing retries it: the schedule or
  the next scan asks for the work again, and a request that was refused is visible
  in the server log rather than in a table.
- The scan schedule lives in memory, so a restart resets the clock for every
  library, exactly as the reference's fixed-rate task does.
- Reading `TASK_POOL_SIZE` happens per tick rather than on a settings change, so
  changing it takes effect without a restart.

## Sets that have been emptied

When a library's trash is emptied - by the task the API queues, or at the end of a
scan for a library with `emptyTrashAfterScan` set - a collection or read list that
has lost everything it held is removed with it, if the server is set to remove them:
`DELETE_EMPTY_COLLECTIONS` and `DELETE_EMPTY_READLISTS`, which are stored settings
and default to off, as they do in the reference. The removal takes the set's poster
with it, and a scan reports how many of each it removed.

What counts as empty is the reference's rule: a collection with no series in it,
and a read list with no book in it. A collection whose series are still stored keeps
its place even when those series have lost all their books, and a read list whose
books are still only _soft_-deleted is not empty either - which is why the cleanup
happens when the trash is emptied rather than on every scan.

## Thumbnails

A book's poster is made from its first page - its cover, for an EPUB - as part of
analysing it, and stored in `thumbnails` as a single `GENERATED` row. It is the
selected row unless the book already had a poster of its own chosen, whether
uploaded or found beside the file, which a generated one never displaces. A new
generated poster replaces the old one rather than joining it.

The size is the `THUMBNAIL_SIZE` setting: `DEFAULT` 300, `MEDIUM` 600, `LARGE` 900
or `XLARGE` 1200 pixels on the longest edge, and it is read when a poster is made.
An image is fitted inside that square and never enlarged, and a JPEG that already
fits is stored as it is rather than re-encoded. Everything else is converted to
JPEG, which is the only format the reference stores either.

A series with no poster of its own shows the poster of one of its books, chosen by
the library's `seriesCover` setting: `FIRST`, `FIRST_UNREAD_OR_FIRST`,
`FIRST_UNREAD_OR_LAST` or `LAST`, where an unread book is one the caller has not
finished. Two people can therefore be shown different covers for one series, which
the reference does too. The book it names decides: if that book has no poster, the
series has none, and no other book is tried.

A collection or a read list shows a mosaic of its first four members, laid out two
by two on a cover-shaped black canvas. The reference does the same, including
repeating the members when there are fewer than four, so a collection of one series
is four of that series' cover. `PUT /books/thumbnails` regenerates them: every book,
or with `for_bigger_result_only=true` only those whose poster is smaller than the
size in force now.

Deliberate differences:

- A series, collection or read list cover is built when it is asked for and is not
  stored, so there is no job that generates one. The reference's `SIDECAR`
  thumbnails - an image sitting beside a series' books - arrive with the local
  artwork work; a generated one is never written for a series.
- A cover that was built on the fly is answered with `private, max-age=60` and no
  entity tag, because a series' cover depends on who is asking. A stored poster
  keeps the reference's `public, max-age=86400`, tagged with the row it came from.
- An owner with nothing to show answers `404`. The reference builds an all-black
  mosaic for a collection that holds nothing.
- Making a poster is a job of its own, queued after the analysis that makes it
  possible, so a book can be browsed before its poster exists. The reference
  arranges it the same way.

## Extensions beyond Komga

Features that Komga does not have. Nothing here changes an existing path, shape or
status code, and nothing here is on by default, so a client written against Komga
never sees any of it.

### Self-service signup

`GET /api/v1/registration` answers `{ "enabled": ..., "defaultRoles": [...] }` without
credentials, so a client knows whether to offer a sign-up screen. `POST
/api/v1/registration` takes `{ email, password }` and creates an account, answering
`204`; `PUT /api/v1/registration` (admin) sets `{ enabled }` and `{ defaultRoles }`.

- **Closed by default.** The stored settings are `REGISTRATION` (`CLOSED`, the
  default, or `OPEN`) and `REGISTRATION_DEFAULT_ROLES` (a comma-separated list,
  defaulting to `PAGE_STREAMING,FILE_DOWNLOAD`). They are deliberately _not_ part of
  the `SettingsDto` the Komga contract defines, so a client reading that sees exactly
  what it always saw.
- **Refused while the server is unclaimed**, which is the same rule the claim route
  uses: an instance with no users has its first account claimed, not registered.
- **`ADMIN` is never handed out**: a role list naming it is refused, and a list
  written into the database by hand has it dropped.
- **Registering does not sign you in.** No session is created, and the account has to
  sign in like any other.
- **No library is shared** with a new account - the same starting point an
  admin-created user has - so an admin decides what a registered account may see.
- **Rate limited** by address (10 attempts per 15 minutes) and by email address (5),
  answering `429`. The counts are per process and in memory; the reference has no rate
  limiting at all, and this does not add any to its paths.
- **Recorded** in the authentication activity log, with the email and whether it
  succeeded, like a sign-in.
- A duplicate address answers `400`, which does tell the caller that the address is
  registered. That is the trade the issue accepts: without it a person cannot tell
  what went wrong. **No email is verified** - the project sends no mail yet - so an
  address is an identifier here exactly as it is for an admin-created account.

## Duplicate pages

Where a page's hash lives, and what a "known" hash is, follow current Komga rather
than the shapes this project started with:

- `media_page.file_hash` is the page's own hash, so "which pages hold this hash" is
  one indexed lookup and a match carries the book, page number, file name, size and
  media type the API returns.
- `page_hash` is one row per hash somebody has judged: its `action` (`DELETE_AUTO`,
  `DELETE_MANUAL` or `IGNORE`), the size, how many times pages with it have been
  deleted, and when it was seen.
- `page_hash_thumbnail` is the image of a known duplicate, which the browser shows
  before removing anything.
- An _unknown_ hash is not stored: it is a page whose hash is absent from
  `page_hash`, with more than one page carrying it, which the API asks for by
  joining the two tables.

An earlier version of this project kept a `page_hash` naming one book and one page, a
`page_hash_match` table and a `page_hash_unknown` table. Migration 0015 reshapes them:
one row per hash, keeping the largest size and the highest delete count, with
`IGNORE` as the action - the old tables had no action column, and `IGNORE` is the
honest reading of "somebody marked this and we do not know why", since it removes
nothing. Rows that described matches or unknown hashes are dropped, because both are
read from `media_page` now, and the importer maps a Komga database - current or from
before mid-2023, when the hash's media type was part of the key - into the same shape.

The API is the reference's, and administrative only - what it lists names files on
disk:

| Route                                              | What it does                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/page-hashes`                          | The hashes somebody has judged, each with how many pages carry it. `action` filters, and repeating it asks for several; a name that is not an action is a `400`. |
| `GET /api/v1/page-hashes/unknown`                  | The hashes nobody has judged, carried by **more than one** page.                                                                                                 |
| `GET /api/v1/page-hashes/{hash}`                   | Every page carrying a hash: its book, the file it is in, its page number, size and media type.                                                                   |
| `GET /api/v1/page-hashes/{hash}/thumbnail`         | The picture stored with a judged hash, which is a JPEG. `404` when it has none.                                                                                  |
| `GET /api/v1/page-hashes/unknown/{hash}/thumbnail` | A page carrying an unjudged hash, as it is stored - or a JPEG when `resize` asks for a maximum edge.                                                             |
| `PUT /api/v1/page-hashes`                          | Judges a hash as `DELETE_AUTO`, `DELETE_MANUAL` or `IGNORE`. A hash that is new keeps a JPEG of one of its pages.                                                |

Three deliberate differences:

- An unknown hash's `size` is the **largest** of the sizes of the pages carrying it.
  The reference reads one of them, and which one is whatever the database returns
  first.
- The order is always defined here: by hash when nothing is asked for, and by the
  property asked for otherwise. The reference leaves an unsorted page to the database,
  which paging cannot be built on.
- Sorting an unknown hash or a match by `url`, `bookId` or `pageNumber` is dropped
  rather than honoured, because a group of pages has no single one of those.

**Removing pages**: `POST /api/v1/page-hashes/{hash}/delete-all` answers `202` and
queues one job per book that carries the hash; `.../delete-match` does the same for
one page named in the body. A scan also removes the pages of a hash marked
`DELETE_AUTO` by itself, which is how "always remove this one" takes effect. The
book's file is rewritten beside the original, checked, and only then put in its
place, so anything that goes wrong leaves the library the book it had:

- A file that changed since it was scanned is left alone: it is not the book the job
  was queued for, and a scan will analyse it and hash its pages again.
- Only an analysed comic archive can be rewritten, and only when the pages to remove
  are exactly the pages it has - a mismatch stops the job.
- The pages that stay keep the hashes they had, and the removal is counted against
  the hash in `delete_count`, which is what tells an operator whether removing the
  rest is worth it. It is also recorded in the history, as `DUPLICATE_PAGE_DELETED`.

Two deliberate differences:

- `delete-match` answers `400` for a page that does not carry the hash. The reference
  accepts the request and quietly does nothing when its own check finds the pages do
  not add up.
- A removal that fails is retried the next time it is asked for. The reference
  remembers a book that failed in the running process and skips it until a restart.
  Every retry is safe, because the checks above are what decide whether anything
  happens.

## Hashing

A book carries two hashes: its file's, which identifies the file itself, and
KOReader's partial MD5 of it, which is how a KOReader reader finds the book on the
server. Its pages carry hashes of their own, which is what finds a duplicate. Each
kind is computed by a job the scan queues, at the lowest priority, and only for the
library settings that ask for it (`hash_files`, `hash_pages`, `hash_koreader` -
`hash_koreader` is off by default, as the reference leaves it).

The file hash and the page hash are XXH3-128 seeded with zero, written as thirty-two
lower-case hex characters, which is what the reference's hasher produces for the same
input. Both are of the bytes as they are stored. The reference **re-encodes a JPEG
page before hashing it**, to strip the EXIF data that makes two copies of one page
differ; Java's encoder cannot be reproduced by the image library this server uses, so
doing the same here would cost time and match nothing - a page that differs from
another only in its metadata therefore hashes differently here. Komga ships no hash of
its own to compare against, so the digest byte order is pinned by the published
XXH3-128 value for an empty input, which both agree on.

The KOReader hash is a partial MD5 over eleven sampled chunks, and follows the
reference's reading of the file rather than KOReader's own, because a database carried
over from Komga holds hashes computed that way:

- the reference shifts a `Long` by a **negative** count for its first sample, which
  Kotlin masks into a 62-bit shift and which overflows to zero, so its first chunk is
  read from the start of the file. KOReader itself shifts by -2, which shifts right,
  and reads from 256 bytes in.
- the reference reads into a buffer it reuses and hands the **whole** buffer to the
  digest, so a short read hashes the tail of the previous chunk again. KOReader hashes
  only the bytes it read.

Both are artefacts of how the reference is written rather than choices, and both are
invisible until KOReader sync is implemented - which is the point at which a
reader-side value has to be matched and this will have to be revisited.

Page hashing follows the reference in what it covers, too: the first and last three
pages of a comic archive (`pageHashing`), and only a comic archive - a PDF's pages are
drawn when they are read and an EPUB's are not the unit a reader navigates, so neither
is hashed. A page that already has a hash keeps it, so a book whose page count grew is
not hashed from the start again.

Hashing changes nothing a client sees but the two new fields on a book, so no event is
announced and no modified date is touched.

## Search conditions

`POST /api/v1/books/list` and `POST /api/v1/series/list` take a `condition`: the typed
tree the Komga UI sends when somebody uses the filter panel. Every field and every
operator the contract names is translated, and the rules are the reference's - which
means a few that surprise until you know they are deliberate:

- A substring comparison (`contains`, `beginsWith`, `endsWith` and their `doesNot`
  forms) ignores case **and accents**, on both sides, so `asterix` finds
  `Astérix le Gaulois`. Equality does _not_ fold accents, only case: that is the
  reference's split, and the two are different operators on purpose.
- `greaterThan` and `lessThan` are **inclusive** (`>=`, `<=`).
- `isNot` on a number that can be empty is also true of a row with no value at all,
  because that is what the UI means by "not 12".
- `isNull` on a list - a tag, a genre, an author, a sharing label - means the book or
  series has none of them, not that one of them is empty. A series' tags include the
  tags of its books, and so do its authors, which come from the aggregation rather
  than from the series' own rows.
- `after` and `before` compare the **date** part in UTC, and are exclusive;
  `isInTheLast` and `isNotInTheLast` take an ISO-8601 duration of days, hours,
  minutes and seconds - `P1M` is refused, as the reference refuses it, because a month
  is not a length of time until you say which one.
- Read status is the caller's own progress. A book with no progress row is unread; a
  series is unread when it has no progress row at all, read when as many of its books
  are read as it holds, and in progress in between. Without a signed-in caller a
  read-status filter matches nothing rather than everything.
- A book with no media row - one that was never analysed - has no status and no
  profile, so neither `is` nor `isNot` on those matches it.
- `poster` reads this server's `thumbnails` table: a `type` of `GENERATED`,
  `SIDECAR` or `USER_UPLOADED`, and whether the picture is the chosen one.

The condition is combined with what the caller may see, never instead of it: searching
for a library somebody cannot read returns nothing, and an age restriction still
narrows the result.

One deliberate difference: a condition that names a field the entity does not have, or
an operator that does not belong with the field, is answered with a `400` naming it.
The reference refuses such a body too - it cannot be deserialised into its own types -
but the message here says which value was wrong.

## Full-text search

`search` on `/books`, `/series`, `/collections` and `/readlists`, and `fullTextSearch`
in the two `POST .../list` bodies, are the same thing: a word somebody typed, and what
matches it best first. Both go through the FTS5 indexes migration 0009 built, which are
kept in step by triggers on the metadata tables.

What is searched is what the reference searches, because it chose the fields when it
wrote its own index: a book's **title and ISBN**, a series' **title and title sort**, a
collection's and a read list's **name**. A book's tags and authors are not searched, and
neither are a series' publisher, genres or labels - they are filters (`condition`), not
search terms.

A term is broken into words, each word is quoted, and the words are joined with `AND`,
which is the default operator the reference gives its query parser. Quoting means the
search language cannot be reached from a search box: a `"`, a `-`, a `NEAR` or a `:` in
a term is a character somebody typed. The one exception is a **trailing `*`**, which
makes that word a prefix - the piece of Lucene's syntax a search box relies on while
somebody is still typing, and the only one this server implements.

A term that has no word in it at all - `!!!`, `"`, `-` - matches **nothing** rather than
everything: the reference's parser throws on such a term and answers with an empty list,
and a filter that silently disappears would show somebody the whole library.

Relevance is FTS5's `bm25`, and it is the default order when a term is given, unless the
caller asked for an order of their own - as it is in the reference. **It is not Lucene's
relevance**: both put an exact title above a longer one and a title above a publisher,
but the numbers they rank by and the way ties break are their own, so two servers will
not always order the same results the same way. Collections and read lists are filtered
by a search but not ranked by it, which is what the reference does with them too.

`search_regex` on `/series` (and its alphabetical groups) is deprecated and no client
sends it. The contract documents the form `pattern,field`, with `TITLE` and `TITLE_SORT`
as the fields, and that is what is read. A value naming a field that is not one is
dropped rather than refused, as the reference drops it. A value with no field at all is
read as a pattern for the title, because that is what this server did before it read
fields, and a filter that disappears would be worse than one that is applied. A pattern
that is not a regular expression is a `400`.

## Events

`/sse/v1/events` carries the changes a browser is watching for. The names and the
shapes are the ones the Komga UI listens for, and the payloads are the reference's
own: a book's event carries its series and its library, a collection's carries the
series it holds, a read list's the books. A library, series, book, collection or read
list add, change and delete is announced by whatever changed it - a route responding
to a user, or the worker finishing a scan, an analysis or a metadata refresh - and
`ReadProgress*`, `Thumbnail*`, `TaskQueueStatus` and `SessionExpired` are announced as
they always were.

Every connection gets every event, as the reference sends them: filtering by what
viewer may see something would mean reading each viewer's restrictions for each one.
A client ignores what it cannot see.

Deliberate differences:

- Emptying a library's trash announces nothing. What was removed was announced as
  deleted when a scan soft-deleted it, and the row going for good is not a change a
  client can see.
- A cover or a poster is announced separately from the content it belongs to, as the
  reference announces it: a book's thumbnail event is what makes a list redraw, and a
  book's own event is what makes its page reload.

## Roles

An account's roles decide what it may do. The set is the reference's:
`ADMIN`, `FILE_DOWNLOAD`, `PAGE_STREAMING`, `KOBO_SYNC`, `KOREADER_SYNC`, and `ADMIN`
satisfies every check.

| Role             | What it gates                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN`          | Every administrative endpoint: users, libraries, settings, the task queue, the history, the duplicate pages, editing series and book metadata, uploading or deleting artwork, claiming an unclaimed server |
| `PAGE_STREAMING` | A book's page list, a page image, a page's thumbnail                                                                                                                                                       |
| `FILE_DOWNLOAD`  | Downloading a book's own file, and the series and read list archives built from them                                                                                                                       |
| `KOBO_SYNC`      | Nothing yet: the Kobo sync API is not implemented, and the role is accepted on an account so a client that asks for it is not refused                                                                      |
| `KOREADER_SYNC`  | Nothing yet, for the same reason                                                                                                                                                                           |

Everything else - browsing series, books, collections and read lists, reading a
poster, searching, one's own read progress and profile - needs only to be signed in.

A role list is validated strictly: an unknown name, a value that is not a name, or a
value that is not an array at all is a `400` naming the offending value. An empty
list is accepted, as the reference accepts it: such an account can sign in and read
its own profile and nothing else. A repeated name is one role.

One addition of ours: the only account that can administer the server cannot be
demoted or deleted, answering `403`. The reference has no such guard. It cannot be
reached through the API as it stands, because these routes already refuse to let an
administrator change their own account - which is the only way to be the last one -
so it is the rule that keeps that true if the first one ever moves.

## Scanning

How a library directory is read - which directory becomes a series, how
exclusions match, what a oneshots folder does, and what happens to files that
disappear - is specified in [SCANNING.md](SCANNING.md). It records Komga's
behaviour rule by rule, and the two places we are deliberately stricter.

## Editing several items at once

The web UI edits the metadata of several series, or several books, from the selection
bar, as the legacy interface does. It differs in how:

- The form starts empty and only what is filled in is applied to every selected item.
  The legacy form starts with the values the items share. Nothing can therefore be
  emptied for several items at once; that is done one item at a time.
- A list that is filled in - genres, tags, sharing labels, authors - replaces each
  item's list, as it does in the legacy form.
- Every field that is filled in is locked on each item, so a metadata refresh does not
  undo it.
- Several books can have their tags and authors edited. The legacy table for changing
  the number and title of each book in one dialog is not here.
- Books are sent in one request (`PATCH /api/v1/books/metadata`); series have no such
  endpoint and are updated one after another.

## Series by first character

`GET /api/v1/series/alphabetical-groups` and `POST /api/v1/series/list/alphabetical-groups`
answer one group per first character of the sort title, in lower case, as the reference
does. Which characters make a letter of the navigation, and that everything else is
`#`, is the client's decision, because it depends on the grouping in use (see
`webui.series_groups` below).

- The character is also stripped of its accent, so `Élan` is counted under `e`. The
  title filter the letter then applies (`titleSort` `beginsWith`) ignores accents too,
  so the count beside a letter is the number of series choosing it lists.
- The web UI keeps the chosen letter in the address as `?nav=`, as the legacy interface
  did.

## Interface settings

The web UI keeps its settings in the client-settings API under the keys the legacy
interface used, so what was saved there is read here.

- Per user: `webui.poster.stretch` and `webui.poster.blur_unread`, stored as `true` or
  `false`. A user who never chose gets stretched posters here; the legacy interface
  showed the whole poster until told otherwise.
- Server-wide: `webui.series_groups`. Only the `name` of the stored value is used
  (`alpha` or `japanese`); the table of groups comes from the build.
- `webui.oauth2.hide_login` and `webui.oauth2.auto_login` are not offered, because
  this server has no OAuth2 login. Values already stored are left as they are.

## Metrics

`GET /actuator/metrics` lists the metrics and `GET /actuator/metrics/{name}` reads one,
in the shape the reference's registry gives: `measurements` of a `statistic` and a
`value`, and `availableTags` to narrow by with `?tag=key:value`. Both are for an
administrator.

| Name                    | Statistic                                   | Tag       |
| ----------------------- | ------------------------------------------- | --------- |
| `komga.series`          | `VALUE`                                     | `library` |
| `komga.books`           | `VALUE`                                     | `library` |
| `komga.books.filesize`  | `VALUE`, in bytes                           | `library` |
| `komga.sidecars`        | `VALUE`                                     | `library` |
| `komga.collections`     | `VALUE`                                     | -         |
| `komga.readlists`       | `VALUE`                                     | -         |
| `komga.tasks.execution` | `COUNT`, `TOTAL_TIME` and `MAX`, in seconds | `type`    |

Where it differs:

- Only these seven exist. The reference's registry also publishes the JVM, HTTP, cache
  and database-pool metrics of its platform, which have no counterpart here.
- `komga.sidecars` counts the cover files found beside books and series. The reference
  also counts metadata files it found beside them, which this server does not track.
- `komga.tasks.execution` is tagged by this server's job names (`ScanLibrary`,
  `AnalyzeBook`, ...), and counts from when the server started, as the reference does.
- What is in the trash is not counted.
- The web UI draws bars where the legacy interface drew pie charts, with no charting
  library.

## Not in scope (yet)

OPDS v1/v2, Kobo sync, KOReader sync, Mihon/Tachiyomi shims, OAuth2/OIDC login,
and the desktop tray app are out of the initial scope.
