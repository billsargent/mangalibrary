# Importing from Komga

`importer/` provides the `komga-import` CLI, which converts a legacy Komga
install into the MangaLibrary database.

## How it works

- Reads the legacy `database.sqlite` **read-only** — the source is never modified.
- Maps Komga's tables into the MangaLibrary schema.
- Preserves IDs, library root paths, users (bcrypt password hashes), metadata and
  locks, read progress, collections, read lists, thumbnails, page hashes and settings.
- Leaves book files untouched: libraries point at the same folders on disk.
- Rebuilds the FTS5 search indexes after loading.

## Usage

```bash
komga-import --from ~/.komga --to ./data
```

Options:

| Flag | Effect |
| --- | --- |
| `--from <dir>` | Legacy Komga config dir (contains `database.sqlite`) |
| `--to <dir>` | Destination config dir for the new database |
| `--dry-run` | Report what would be imported, write nothing |
| `--rescan-only` | Import users/settings/collections/read lists, then rescan libraries from disk |

The importer is idempotent for a clean destination. It refuses to write into a
destination that already contains data unless `--force` is given (make a backup first).

## After importing

1. Start the server pointed at the destination config dir.
2. Verify a library scan finds the expected series/books.
3. Sign in with your existing Komga credentials.
