# Scanning: how a library directory is read

Komga's scanner is the reference implementation. This document records what it
does, precisely enough to reimplement, because the behaviour is full of small
decisions that a user will notice: which directory becomes a series, what happens
to files directly in a root, how exclusions match, and what a oneshot folder does.

Two classes do the work in Komga:

- `FileSystemScanner.scanRootFolder` (`komga/src/main/kotlin/org/gotson/komga/domain/service/FileSystemScanner.kt`)
  walks the filesystem and returns series and books. It has no database access and
  no settings of its own - everything is passed in.
- `LibraryContentLifecycle.scanRootFolder` (`.../domain/service/LibraryContentLifecycle.kt`)
  reads the library's settings, calls the scanner, and reconciles the result
  against the database: create, update, soft-delete, restore.

`ScanLibrary` is a task; analyze, extension repair and CBZ conversion are queued
as separate tasks _after_ the walk, never as part of it.

## The rules, in order

1. **The root must be a readable directory.** Otherwise the library is marked
   unavailable and the scan fails.
2. **The accepted extension set comes from the library's settings**, and is
   extension-only:
   - `scanCbx` adds `cbz`, `zip`, `cbr`, `rar`
   - `scanPdf` adds `pdf`
   - `scanEpub` adds `epub`
     Comparisons are case-insensitive. Magic-byte detection happens during
     _analysis_, not during the walk.
3. **Walk the root recursively**, with no depth limit, following symlinks.
4. **Entering a directory:** skip it, and everything beneath it, when its _name_
   starts with `.`, or when its _full path_ contains any exclusion as a
   case-insensitive substring. Otherwise remember it as a candidate series with
   `name` = the directory name (or the full path when that is blank, as for a
   filesystem root) and `url` = the directory.
5. **Visiting a file:** skip it when its extension is not in the set, or its name
   starts with `.`. A book's `name` is its filename without the extension.
6. **Leaving a directory:**
   - no direct book files → it is **not** a series, though its subdirectories may
     be;
   - `oneshotsDirectory` is set **and** the directory's full path contains it as a
     case-insensitive substring → **one series per file**, each named after the
     file, marked `oneshot`, and the directory itself produces no normal series;
   - otherwise → **one series** holding every book directly inside it.
7. **Reconcile with the database:** stamp the library id; soft-delete (set a
   deleted date) every series and book that is no longer on disk - and, when a
   scan finds nothing at all, soft-delete everything in the library. A series is
   treated as changed when its modified time differs, when it had been deleted, or
   when it lost books; book-level work is skipped for unchanged series unless the
   scan is deep. Then books are renumbered from 1 in natural name order.
8. **After a successful scan:** hard-delete the soft-deleted rows when
   `emptyTrashAfterScan` is set, otherwise just clean up empty collections and
   read lists if the corresponding server settings are on.

## Consequences worth stating plainly

- **A directory can be both a series and the parent of series.** `dir/comic.cbz`
  alongside `dir/sub/comic2.cbz` gives two series.
- **Book files directly in the library root** make the root itself a series.
- **Exclusion matching is a substring of the whole path, not a glob and not a
  filename match.** An exclusion of `backup` also matches `/library/mybackup` and
  `/library/backups`. It applies to directories only - never to a filename - and
  it stops the walk below the match. It also applies to the root itself, so an
  exclusion matching the root path scans nothing, which soft-deletes the library's
  contents.
- **`oneshotsDirectory` travels the same way.** A nested `normal/_oneshots`
  folder is treated as oneshots too.
- **Nothing is removed by a scan.** Missing files produce a soft delete, and the
  rows are what makes restore possible.
- **Restore is hash-based.** A file the library does not have is compared with the
  deleted books of exactly its size, by content hash. When one matches, that book
  is un-deleted and pointed at the file, so its id, metadata, thumbnails, read
  progress and read-list membership are all still there - whether the file came
  back where it was, was renamed, or moved to another series or library. A folder
  whose every file matches a book of one deleted series, with no book of that
  series left over, restores the series the same way, which is what keeps a renamed
  series folder from becoming a new series. Komga creates a new row and moves
  everything across to it; we keep the old row, which comes to the same thing with
  less to go wrong.
  - A file is only hashed when a deleted book of its size has a hash to compare
    with, so adding books to a library with an empty trash reads no file.
  - A deleted book that was never hashed (the library has file hashing off, or the
    hash job had not reached it) is restored only when the file is back at the same
    path with the same size and modified date. Otherwise the file becomes a new
    book and the old one waits in the trash.
  - The trash is emptied after restoring, so a library set to empty its trash after
    every scan still keeps a renamed series.
- **A scan can be stopped at any point.** Everything written for one series - the
  series, its metadata row, its books, their numbers and the folder date the next scan
  compares against - is written together or not at all. A scan cut short by a restart
  or a drive going away leaves each series either done or untouched, and the next scan
  carries on from there. Komga writes row by row.
- **Only a series that changed is read again.** After the folders have been compared,
  metadata and local artwork are refreshed for the series the scan added or changed and
  for no others, so a scan over an unchanged library opens no book.
- **Unsupported content is not a scan failure.** A file with an accepted
  extension whose content is unrecognised still becomes a book; the analysis step
  marks its media unsupported (`ERR_1001`).

## Where we will be stricter

- **Symlinks.** Komga follows directory symlinks, which can pull content from
  outside the root and produces duplicate series (one per link, one per real
  directory). We keep reading them, because users rely on them, but the resolved
  path is checked to stay inside the library root, the same guard the file
  download endpoint uses.
- **The root that is excluded.** Rather than soft-deleting an entire library
  because an exclusion matched its root path, we refuse the scan and mark the
  library unavailable, which is both honest and reversible.

## Storing what the scan finds

Komga stores absolute `file:` URLs for `series.url` and `books.url`, and the
importer copies them across unchanged. Our scanner does the same, so a migrated
library and a freshly scanned one are indistinguishable. The cost is that moving a
library root needs a re-scan; the file download endpoint accepts a root-relative
path as well, so a hand-written row keeps working.

`walkLibrary` in `server/src/scan/library.ts` is the walk, and takes a folder and
the library's settings, with no database access. `scanLibrary` in
`server/src/scan/reconcile.ts` is the reconciliation: it creates, updates,
soft-deletes and renumbers, marks a changed book's media outdated, marks the
library unavailable when the walk cannot proceed, empties the trash when the
library asks for it, and leaves everything else to the trash. The matching of a
returning file to a deleted book is in `server/src/scan/restore.ts`.

Our schema stores the exclusions in `libraries.scan_directory_exclusions` (a JSON
list) rather than a table of its own; the semantics are the ones above.

## Still to decide

- Whether `#recycle`, `@eaDir` and `@Recycle` should be defaulted onto new
  libraries. Komga seeds them only for libraries that existed when it added the
  feature, so a new Komga library starts with no exclusions. Matching that is the
  compatible choice, and it is what we do today.

## Files beside the books

A cover named after a book, a cover in a series' folder and a `series.json` say something
about a book or a series without being one. Changing one changes no book, and editing one
where it lies need not change the date of the folder it is in, so a scan that looked only
at books and folders would not notice.

The walk reports each of these files with its date, and the `sidecars` table remembers
them - as the reference's does. When a file is new, has a new date or has gone:

- a series' `series.json`: the series' metadata is read again;
- a series' cover: the series' artwork is looked at again, and nothing else;
- a book's cover: a `RefreshBookLocalArtwork` job is queued, if the book has been
  analysed. One that has not will look for its cover when it is.

The dates come from the look at each file the walk already takes, so a scan over a
library where nothing changed still opens no file.

The first scan after this was added sees every such file as new. That costs a look at
each series' covers, and a re-read of each series that has a `series.json`.
