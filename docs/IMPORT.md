# Importing from Komga

`importer/` provides the `komga-import` command, which turns a Komga install into a
Manga Library database: users and their passwords, libraries, series and books with
their metadata and locks, read progress, collections, read lists, covers, duplicate
page hashes and settings. Book files are not touched, and are not read: what Komga
already knew about each book comes across, so nothing has to be scanned or analysed
again.

## Usage

Stop Komga (or copy its `database.sqlite` somewhere first), then, from the cloned
folder:

```bash
cd importer
npm run import -- --from ~/.komga --to ~/.mangalibrary \
  --map /srv/manga=/mnt/manga --timezone Europe/Berlin --check-files --dry-run
```

Read the report, then run it again without `--dry-run`. Start the server with the
destination as its data folder, and sign in with your Komga email and password.

| Flag                | Effect                                                                             |
| ------------------- | ---------------------------------------------------------------------------------- |
| `--from <dir>`      | Komga's config folder, the one holding its `database.sqlite`. Only ever read.      |
| `--to <dir>`        | The data folder to create the new `database.sqlite` in                             |
| `--map <old>=<new>` | A folder as Komga saw it, and where it is now (see below). Repeatable.             |
| `--check-files`     | Look for every book's file where the import puts it, and report the ones not there |
| `--timezone <zone>` | The time zone Komga ran in (see below). Default: this machine's zone.              |
| `--dry-run`         | Do everything but write                                                            |
| `--force`           | Replace what the destination already holds. Back it up first.                      |
| `--rescan-only`     | Import users, libraries and settings only; the libraries are then scanned afresh   |

The importer refuses a destination that already has users or libraries unless
`--force` is given. Everything is written in one transaction: an import that fails
part-way leaves the destination as it was.

## Where the books are now

Komga recorded each library, series and book by its location on the machine it ran
on. If the books are somewhere else now - another machine, another mount point,
another drive - say where with `--map`:

```bash
--map /srv/manga=/mnt/manga
```

Every library under `/srv/manga` is then looked for under `/mnt/manga`, and every
series, book and cover found beside a book moves with its library.

Give `--map` once for each folder that moved. Give it more than once for the same
folder when its libraries are not all in one place now: each library goes to the
first place given that has its folder.

```bash
--map /srv/manga=/mnt/archive --map /srv/manga=/mnt/manga
```

The report lists each library with where it was and where it is now, and marks the
ones whose folder was found nowhere. With `--check-files` it also counts the books
whose files are not where the import put them, library by library, with examples.

A library whose folder is not found is still imported. When it is scanned, the server
will treat its books as gone, so fix the `--map` and import again with `--force`
before scanning it.

## The time zone Komga ran in

Komga stores every date - when each file was last changed, when a book was read -
as a local time of the machine it ran on, with no zone. Give that zone with
`--timezone` (`Europe/Berlin`, `America/New_York`; `UTC` for Komga in most
Docker containers, which run in UTC unless `TZ` is set). Without it, the zone of the
machine running the import is used.

A wrong zone shifts every date by hours. Worse, a scan compares each file's time with
the one stored, so it takes every book for a changed one and reads it all again.
`--check-files` compares the times as well: the report says how many files carry
the time Komga recorded and how far off the rest are. If most are off by the same
whole number of hours, Komga ran in another zone; import again with the right one.
Files whose times differ for other reasons (copied, touched) are read again by the
first scan, as Komga would have done.

## What is carried over

Libraries and their folder exclusions, users with roles, library sharing, age and
label restrictions, series and book metadata with every lock, authors, tags, genres,
links and sharing labels, what Komga worked out of each series' books (summary,
release date, authors, tags), media status and pages with their hashes, covers
(generated, uploaded, and the ones found beside books), read progress (per book and
per series), collections, read lists, server and client settings, and duplicate page
hashes with their images.

## What is not

The report names each of these that the Komga database has:

- **API keys.** Komga keeps only a hash of each key, so they cannot be used here. Make
  new ones after signing in.
- The history of scans and deletions, the record of sign-ins, which announcements
  were read, Kobo sync points, and alternate series titles.
- The record of files beside books (sidecars): the first scan finds them again.

## After importing

1. Start the server with the destination as its data folder.
2. Sign in with your Komga credentials.
3. Scan a library. A scan that finds the books where the import put them adds and
   removes nothing; if it reports many books added and removed, the `--map` was wrong.
