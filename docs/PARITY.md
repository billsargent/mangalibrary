# Parity with Komga: what has been checked, and what has not

This is the record of going through Komga's server and web UI and asking, feature by
feature, whether this project has it. It was first written on 2026-10-13. Before then
the work followed three partial lists - an early review's issues, the endpoints the new
web UI calls, and the old web UI's screens - and nobody had read Komga's code module by
module. Two faults found by accident showed the cost: a library switch that did nothing,
and a CBR reader that could not read a page.

`COMPATIBILITY.md` says how this server _differs on purpose_. This file says what is
_missing or unexamined_.

## How to read it

Each row says how it was checked, because the three are not worth the same:

- **Test** - a test in this repository compares the two and fails if they drift.
- **Read** - Komga's source was read beside ours.
- **Search** - Komga's source was read, and ours was searched for a counterpart without
  being read in full. A "missing" found this way is reliable; a "present" is not proof
  that it behaves the same.
- **Not examined** - nobody has looked. These are listed so that the gap is visible.

## 1. The REST API

**Test:** `server/src/routes/api-parity.test.ts` asks for every operation in Komga's API
description (`server/spec/komga-openapi.json`) and fails if one that should be served is
not, or one listed as missing starts being served.

Of 174 operations, **168 reach a route and 6 do not**:

| Operation                                                   | State                              | Issue |
| ----------------------------------------------------------- | ---------------------------------- | ----- |
| `PUT /api/v1/libraries/{id}`                                | Not served: deprecated, `PATCH` is | -     |
| `GET /api/v1/oauth2/providers`                              | Missing: no OAuth2 login           | #167  |
| `GET`, `PUT /api/v1/readlists/{id}/read-progress/tachiyomi` | Missing: Mihon                     | #167  |
| `GET`, `PUT /api/v2/series/{id}/read-progress/tachiyomi`    | Missing: Mihon                     | #167  |

Outside that description, and so outside the test: OPDS v1 and v2, Kobo sync and
KOReader sync. None is implemented (#167).

**Not examined:** whether each of the 168 served operations takes the same parameters and
answers the same codes and shapes as Komga's. The departures found so far are in #113
and `COMPATIBILITY.md`. `ui-contract.test.ts` covers the subset the web UI calls, by
name only.

## 2. Background tasks

**Read:** `application/tasks/Task.kt` and `TaskHandler.kt` beside `server/src/handlers.ts`.

| Komga task                                                   | Here                                 | State                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScanLibrary`                                                | `ScanLibrary`                        | Present. See section 4 for what follows a scan                                                                                                                                                                                        |
| `AnalyzeBook`, `GenerateBookThumbnail`                       | same names                           | Present                                                                                                                                                                                                                               |
| `RefreshBookMetadata`, `RefreshSeriesMetadata`               | same names                           | Present. Analysis reads a book's metadata itself here, where Komga queues a refresh                                                                                                                                                   |
| `AggregateSeriesMetadata`                                    | part of `RefreshSeriesMetadata`      | Present, not a job of its own                                                                                                                                                                                                         |
| `RefreshBookLocalArtwork`, `RefreshSeriesLocalArtwork`       | same names                           | Present                                                                                                                                                                                                                               |
| `HashBook`, `HashBookPages`, `HashBookKoreader`              | same names                           | Present                                                                                                                                                                                                                               |
| `FindBooksWithMissingPageHash`, `FindDuplicatePagesToDelete` | done inline after a scan             | Present, not jobs of their own                                                                                                                                                                                                        |
| `RemoveHashedPages`                                          | same name                            | Present                                                                                                                                                                                                                               |
| `FindBooksToConvert`, `ConvertBook`                          | `ConvertBook`, queued after a scan   | Present since #161                                                                                                                                                                                                                    |
| `EmptyTrash`                                                 | same name                            | Present                                                                                                                                                                                                                               |
| `DeleteBook`, `DeleteSeries`                                 | `DeleteBookFile`, `DeleteSeriesFile` | Present since #166 - see section 3                                                                                                                                                                                                    |
| `FindBookThumbnailsToRegenerate`                             | `RegenerateBookThumbnails`           | Present                                                                                                                                                                                                                               |
| `ImportBook`                                                 | same name                            | Present since #171 (`media/import.test.ts`). An upgrade keeps the book's id, where Komga makes a new book                                                                                                                             |
| `RepairExtension`                                            | -                                    | **Missing** (#164)                                                                                                                                                                                                                    |
| `RebuildIndex`, `UpgradeIndex`                               | -                                    | Not needed: these rebuild a separate Lucene index when its format changes. Here the index is a table of the database, kept by triggers and rebuilt by a migration when it changes (0016). The reference has no endpoint for it either |

## 3. What the services do

**Read**, for the parts named; **Search** for our side unless a test is cited.

### Libraries - `LibraryLifecycle`

**Read**, and present since #165 with tests (`routes/api.test.ts`).

| Komga                                                                    | Here                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Refuses a root that does not exist or is not a folder                    | Present                                                                                                   |
| Refuses a name already in use                                            | Present                                                                                                   |
| Refuses a root inside, or containing, another library's                  | Present, compared as the disk spells the paths                                                            |
| Checks all of that again on every update                                 | **Differs on purpose**: only what is being changed, so a library whose folder is gone can still be edited |
| Scans a new library at once                                              | Present                                                                                                   |
| On update: rescans when what is scanned for changed                      | Present                                                                                                   |
| On update: queues hashing or conversion when one is switched on          | Present, by asking for a scan, which queues that work for the books that need it                          |
| Scan on startup, and on each library's interval, rescheduled on a change | Present (`worker.ts`)                                                                                     |

### Deleting files - `BookLifecycle.deleteBookFiles`, `SeriesLifecycle.deleteSeriesFiles`

**Read**, and present since #166 with tests (`content/delete.test.ts`).

| Komga                                                                   | Here                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Removes the file and the artwork found beside it                        | Present                                                                                  |
| Records `BookFileDeleted` in the history                                | Present                                                                                  |
| Removes the folder when it is left empty, and records it                | Present. **Stricter on purpose**: never the library's own folder                         |
| Deleting a oneshot deletes its series                                   | Present                                                                                  |
| Removes a series' own artwork, then its folder if empty                 | Present                                                                                  |
| Does nothing when the file is missing or cannot be written              | Present                                                                                  |
| Leaves a series whose last book was deleted listed, empty, until a scan | **Differs on purpose**: it goes to the trash with its last book when its folder went too |

### Reading progress - `BookLifecycle.markReadProgress`, `markProgression`

| Komga                                                                | Here                                   | Issue |
| -------------------------------------------------------------------- | -------------------------------------- | ----- |
| A page outside the book is refused; the last page completes the book | Present (`progression.test.ts`)        | -     |
| EPUB progression matched to a position, exact or the one before      | Present (`progression.ts`)             | -     |
| A progression older than the one stored is refused                   | Present since #170 (`content.test.ts`) | -     |

### Users - `KomgaUserLifecycle`

| Komga                                                                      | Here                                | Issue |
| -------------------------------------------------------------------------- | ----------------------------------- | ----- |
| Changing roles, restrictions or shared libraries ends the user's sessions  | Present (`routes/users.ts`)         | -     |
| Deleting a user removes their progress, settings, activity and sync points | Present, by the database's cascades | -     |
| Two API keys of one user cannot have the same comment (`ERR_1034`)         | Present since #170 (`api.test.ts`)  | -     |
| API keys are stored hashed                                                 | **Differs**: stored as they are     | #114  |
| A first user is created at startup when configured                         | Different by design: the claim flow | -     |

### Converting and repairing - `BookConverter`

Convert to CBZ: present since #161 (`media/convert.test.ts`). Repair extensions:
**missing** (#164).

### Scanning - `LibraryContentLifecycle`, `FileSystemScanner`

Read rule by rule when the scanner was written; see `SCANNING.md`. Restoring deleted
books and series by hash: present (#143). Komga's sidecar table - a scan noticing that a
cover or a metadata file changed without its book changing - is present since #174.

### Collections and read lists - `SeriesCollectionLifecycle`, `ReadListLifecycle`, `ReadListMatcher`

**Read** on 2026-10-13 beside `organisation/membership.ts` and the two route files.

| Komga                                                                                                | Here                                        | Issue |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----- |
| A series joins a collection, and a book a read list, by name; either is created when it is not there | Same (`organisation.test.ts`)               | -     |
| A book goes where its document says, or to the end when that place is taken                          | Same                                        | -     |
| Empty ones are removed when the trash is emptied, if the server is set to                            | Same                                        | -     |
| A poster made of four members' posters when none was uploaded                                        | Present                                     | -     |
| A name already in use is refused, on create and on update, whatever its capitals                     | Present since #177 (`organisation.test.ts`) | -     |
| Matching a ComicRack list says when its name is taken (`ERR_1009`)                                   | Present since #177                          | -     |
| A ComicRack list that cannot be used is refused with a code (`ERR_1015`, `ERR_1029` to `ERR_1031`)   | Present since #177                          | -     |
| A collection made from ComicInfo is unordered, and one is found by name whatever its capitals        | Present since #177                          | -     |

### What analysis reports - `BookAnalyzer`

**Read** on 2026-10-13 for the outcomes only, not for how each format is read.

| Komga                                                                                                                                   | Here                                                         | Issue |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----- |
| A book that cannot be read, or is of no supported kind, is recorded with a code                                                         | Present for three codes (`ERR_1000`, `ERR_1001`, `ERR_1005`) | -     |
| A book with no pages is an error (`ERR_1006`)                                                                                           | **Differs**: recorded as ready, with no pages                | #178  |
| Unrecognised entries, a missing file, encrypted and multi-volume RARs, a malformed EPUB and the EPUB parts that failed each have a code | **Missing**: all are `ERR_1005` or not recorded              | #178  |

### Metadata - `MetadataApplier`, `MetadataAggregator`, `BookMetadataLifecycle`, `SeriesMetadataLifecycle`

**Read** on 2026-10-13, every file, beside `server/src/metadata/`; what was found is #173.
Tests: `metadata/*.test.ts`, and `metadata/lifecycle.test.ts` for what happens across a
scan, an analysis and the refreshes that follow.

| Komga                                                                                                                                      | Here                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| A patch replaces a field only when it carries a value and the field is not locked                                                          | Same                                                                                                                   |
| A series' view of its books: union of credits and tags, earliest date, the first summary by number                                         | Same                                                                                                                   |
| A series from its books: the most frequent title, publisher, language and direction; the highest age rating and count; the union of genres | Same                                                                                                                   |
| Each provider's patch is folded and applied on its own, one after another                                                                  | Same since #173; comics and EPUBs were counted together                                                                |
| Renumbering a series re-reads the number of each book whose number moved                                                                   | Present since #173. **Was a fault**: a number from ComicInfo was replaced by the book's place for good                 |
| A oneshot's series is its book: title, summary, ended, one book                                                                            | Same rule. **Was a fault** until #173: the series was read before the book had been analysed, and kept the file's name |
| The book, series, read-list and collection switches of ComicInfo are independent                                                           | Same since #173; read lists and collections needed the other two                                                       |
| After a book is refreshed, its series is; after a series, its aggregation                                                                  | Same (`handlers.ts`)                                                                                                   |
| A refresh asked for some fields runs the providers that have them, and writes all they read                                                | **Differs on purpose**: only the fields asked for are written                                                          |

### The metadata providers

**Read** on 2026-10-13, each beside its counterpart.

| Provider                           | State                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ComicInfo (`comicinfo.ts`)         | Same fields, roles, age ratings and reading direction. Story arcs are paired with their numbers by position since #173. **On purpose**: found in any folder of the archive and whatever its capitalisation; a date that is not one drops the date, not the document |
| EPUB (`epub.ts`)                   | Same fields and roles. **Was a fault** until #173: a self-closing `<meta/>` before the collection lost the series and the number. **On purpose**: a role needs no `scheme`, and `urn:isbn:` is accepted                                                             |
| Mylar `series.json` (`sidecar.ts`) | Same title rule, status, summary and age ratings. **On purpose**: read leniently, where Komga refuses a file with a field missing                                                                                                                                   |
| Oneshot                            | Same                                                                                                                                                                                                                                                                |
| ISBN barcode (`barcode.ts`)        | Same pages, same format. **On purpose**: applied before the documents, so a document's ISBN wins                                                                                                                                                                    |
| Local artwork (`localArtwork.ts`)  | Same names, extensions and choice of which is selected                                                                                                                                                                                                              |
| Language tags                      | **On purpose**: checked for shape, not against a list of languages                                                                                                                                                                                                  |

Komga's sidecar table (`infrastructure/sidecar`), with which a scan notices that a cover
or a `series.json` changed without its book or folder changing: present since #174
(`scan/sidecars.test.ts`). **On purpose**: a changed cover has the series' artwork looked
at again, not its books read again.

### Not examined at all

- `SyncPointLifecycle`: sync points exist in the schema and one endpoint deletes them;
  they serve Kobo sync, which is on hold (#167).
- `TransientBookLifecycle`: the import preview. Present; not compared.
- `PageHashLifecycle`: present with its API (#82, #85); not compared method by method.

## 4. What runs on a timer or at startup

**Read:** `interfaces/scheduler/*`.

| Komga                                                   | Here                                         | Issue |
| ------------------------------------------------------- | -------------------------------------------- | ----- |
| Scan on startup; scan on each interval                  | Present                                      | -     |
| Daily clean-up of authentication activity, kept a month | Present since #170 (`auth/activity.test.ts`) | -     |
| Create the search index when there is none              | Not needed: the index is part of the schema  | -     |
| Publish metrics                                         | Present, computed on request (#145)          | -     |
| Create an initial user                                  | Different by design: the claim flow          | -     |

## 5. Security and sessions

**Search** only. Session cookie, `X-Auth-Token`, Basic and API-key sign-in, remember-me
and CORS exist. **Not examined:** the order the mechanisms are tried in, what each
endpoint requires compared with Komga's `SecurityConfiguration`, and session limits.
Hardening this server needs regardless of Komga is #114.

## 6. Reading and serving files

| Komga                                           | Here                                                                                                              | Issue |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| CBZ, CBR, PDF and EPUB pages                    | Present. CBR could not be read until #158                                                                         | -     |
| Download a book; a series or read list as a zip | Present                                                                                                           | -     |
| A download can be resumed (HTTP range requests) | Present since #170 for a book file (`pages.test.ts`). A series or read list is zipped as it is sent and cannot be | -     |
| EPUB resources, manifests and positions         | Present (#138)                                                                                                    | -     |
| PDF page as a PDF (`/raw`)                      | Present since #170 (`pages.test.ts`)                                                                              | -     |
| Kepub conversion for Kobo                       | **Missing**; part of Kobo sync                                                                                    | #167  |

## 7. The web UI

The new UI is a fork of Komga's own rewrite (`next-ui`), so it began where upstream was.
**Search:** every screen of the old UI (`komga-webui/src/views`) has a page here, and no
page is a placeholder any more. Each of these was found in the new UI's code: library
actions (scan, analyse, refresh, empty trash), mark read and unread, analyse and refresh
for books and series, add to collection and read list, deleting files, the file browser,
user restrictions and shared libraries, the import previews, the reader's page strip and
shortcuts, announcements and updates, authentication activity, live updates.

**Not examined:** each dialog and menu of the old UI opened beside the new one. Known
gaps are tracked: search filters (#134), EPUB reader (#137), removing from the selection
bar (noted on #103). The Import > Books page works since #171.

Not present and not planned: installing the UI as an app (a service worker).

## 8. Whole subsystems that are absent

OPDS v1 and v2, KOReader sync, Mihon, Kobo sync, OAuth2 login. Sized, and waiting for a
decision, in #167. Packaging - a Docker image and a single binary - is #11.

## What to do with this file

When a row marked "not examined" is examined, replace it with what was found. When a
gap is closed, the row says "present" and names the test. A new gap gets an issue and a
row. The one part that checks itself is section 1.
