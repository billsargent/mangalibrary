import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'

import { requireAuth } from '../auth/session.js'
import type { DB } from '../db/schema.js'
import { profileFor } from '../media/kinds.js'
import type { TocEntry } from '../media/types.js'
import { buildBookDtos } from './content-data.js'
import type { BookDto, BookRow } from './content-dto.js'
import { contentContext, seriesAllowed } from './context.js'
import type { RouteOptions } from './libraries.js'

/** The two manifest media types, and the Readium profiles a manifest conforms to. */
const WEBPUB_TYPE = 'application/webpub+json'
const DIVINA_TYPE = 'application/divina+json'
const CONTEXT = 'https://readium.org/webpub-manifest/context.jsonld'
const CONFORMS_TO = {
  DIVINA: 'https://readium.org/webpub-manifest/profiles/divina',
  EPUB: 'https://readium.org/webpub-manifest/profiles/epub',
  PDF: 'https://readium.org/webpub-manifest/profiles/pdf',
} as const

const REL_ACQUISITION = 'http://opds-spec.org/acquisition'

/** Image formats a reader is expected to show without asking for a conversion. */
const RECOMMENDED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif']

/** The acquisition type of a book: the comic-book type of an archive, else its own. */
const EXPORT_TYPES: Record<string, string> = {
  'application/zip': 'application/vnd.comicbook+zip',
  'application/x-rar-compressed': 'application/vnd.comicbook-rar',
}

const KNOWN_AUTHOR_ROLES = [
  'author',
  'translator',
  'editor',
  'artist',
  'illustrator',
  'letterer',
  'penciler',
  'penciller',
  'colorist',
  'inker',
]

type Link = Record<string, unknown>
type Publication = Record<string, unknown>
type Profile = keyof typeof CONFORMS_TO

/**
 * Drop the empty values the reference's WebPub DTOs never serialise.
 *
 * Jackson is configured with `NON_EMPTY` for these objects, so an empty string,
 * list or object is left out rather than sent as `[]` or `{}`. The published
 * OpenAPI document still marks them required, which is why this is done by hand.
 */
function prune(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '') continue
    if (Array.isArray(item) && item.length === 0) continue
    if (typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) continue
    out[key] = item
  }
  return out
}

/** Encode a path that names an entry inside a book, keeping its separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** Where the API answers, as an absolute URL, so a manifest is portable. */
function baseUrl(req: FastifyRequest): string {
  const host = req.host || req.headers.host || 'localhost'
  return `${req.protocol}://${host}/api/v1`
}

function readingProgression(direction: string | null): string | undefined {
  switch (direction) {
    case 'LEFT_TO_RIGHT':
      return 'ltr'
    case 'RIGHT_TO_LEFT':
      return 'rtl'
    case 'VERTICAL':
    case 'WEBTOON':
      return 'ttb'
    default:
      return undefined
  }
}

interface SeriesInfo {
  language: string | null
  readingDirection: string | null
}

/** The metadata block shared by every profile. */
function metadataOf(book: BookDto, series: SeriesInfo, numberOfPages: number, conformsTo: string) {
  const namesWithRole = (role: string) =>
    book.metadata.authors.filter((author) => author.role === role).map((author) => author.name)
  const isbn = book.metadata.isbn.trim()

  return prune({
    title: book.metadata.title,
    identifier: isbn === '' ? undefined : `urn:isbn:${isbn}`,
    conformsTo,
    modified: book.lastModified,
    published: book.metadata.releaseDate?.slice(0, 10),
    language: series.language ?? undefined,
    author: namesWithRole('author'),
    translator: namesWithRole('translator'),
    editor: namesWithRole('editor'),
    artist: namesWithRole('artist'),
    illustrator: namesWithRole('illustrator'),
    letterer: namesWithRole('letterer'),
    penciler: [...namesWithRole('penciler'), ...namesWithRole('penciller')],
    colorist: namesWithRole('colorist'),
    inker: namesWithRole('inker'),
    contributor: book.metadata.authors
      .filter((author) => !KNOWN_AUTHOR_ROLES.includes(author.role))
      .map((author) => author.name),
    subject: book.metadata.tags,
    readingProgression: readingProgression(series.readingDirection),
    description: book.metadata.summary,
    numberOfPages,
    belongsTo: prune({ series: [prune({ name: book.seriesTitle, position: book.metadata.numberSort })] }),
  })
}

/** The `self`, optional `divina` and `acquisition` links of every publication. */
function publicationLinks(
  req: FastifyRequest,
  bookId: string,
  kind: Profile,
  mediaType: string | null,
  divinaCompatible: boolean,
): Link[] {
  const base = baseUrl(req)
  const links: Link[] = [
    prune({
      rel: 'self',
      href: `${base}/books/${bookId}/manifest`,
      type: kind === 'DIVINA' ? DIVINA_TYPE : WEBPUB_TYPE,
    }),
  ]

  // A PDF, and an EPUB whose pages are all images, can also be read page by page.
  if (kind === 'PDF' || (kind === 'EPUB' && divinaCompatible)) {
    links.push(prune({ href: `${base}/books/${bookId}/manifest/divina`, type: DIVINA_TYPE }))
  }

  links.push(
    prune({
      rel: REL_ACQUISITION,
      type: mediaType === null ? 'application/octet-stream' : (EXPORT_TYPES[mediaType] ?? mediaType),
      href: `${base}/books/${bookId}/file`,
    }),
  )

  return links
}

interface PageRow {
  number: number
  file_name: string
  media_type: string
  width: number | null
  height: number | null
}

/**
 * Reading order of a page-per-file book.
 *
 * A PDF's pages are rendered to images by this server, so they point at the page
 * image rather than at a raw PDF page - which the reference serves and this
 * server cannot extract. A Divina book points at its page images, and a page a
 * reader may not be able to show gets an `alternate` link to a JPEG conversion.
 */
function pageReadingOrder(req: FastifyRequest, bookId: string, kind: 'DIVINA' | 'PDF', pages: PageRow[]): Link[] {
  const base = baseUrl(req)
  return pages.map((page) => {
    if (kind === 'PDF') {
      return prune({
        href: `${base}/books/${bookId}/pages/${page.number}`,
        type: page.media_type,
        width: page.width ?? undefined,
        height: page.height ?? undefined,
      })
    }

    const href = `${base}/books/${bookId}/pages/${page.number}?contentNegotiation=false`
    const alternate =
      page.media_type.startsWith('image/') && !RECOMMENDED_IMAGE_TYPES.includes(page.media_type)
        ? [
            prune({
              href: `${href}&convert=jpeg`,
              type: 'image/jpeg',
              width: page.width ?? undefined,
              height: page.height ?? undefined,
            }),
          ]
        : []

    return prune({
      href,
      type: page.media_type,
      width: page.width ?? undefined,
      height: page.height ?? undefined,
      alternate,
    })
  })
}

/** A table of contents, with hrefs pointing inside the book's resources. */
function tocLinks(entries: TocEntry[], resourceBase: string): Link[] {
  return entries.map((entry) => {
    const [path, ...fragment] = entry.href?.split('#') ?? []
    return prune({
      title: entry.title,
      href:
        path === undefined
          ? undefined
          : `${resourceBase}${encodePath(path)}${fragment.length > 0 ? `#${fragment.join('#')}` : ''}`,
      children: tocLinks(entry.children, resourceBase),
    })
  })
}

interface BookContext {
  book: BookDto
  mediaType: string | null
  kind: Profile
  divinaCompatible: boolean
  series: SeriesInfo
  pages: PageRow[]
}

/**
 * Resolve everything a manifest is built from, or the reply to send instead.
 *
 * A manifest cannot be written for a book whose contents are unknown, so a book
 * that is missing, invisible to the caller or not analysed is reported the way
 * the other book endpoints report it.
 */
async function resolveBook(
  db: Kysely<DB>,
  req: FastifyRequest,
  bookId: string,
): Promise<{ code: number; message: string } | BookContext> {
  const row = await db.selectFrom('books').selectAll().where('id', '=', bookId).executeTakeFirst()
  if (!row) return { code: 404, message: 'Book not found' }

  const context = await contentContext(db, req)
  if (!seriesAllowed(context, row.series_id, row.library_id)) return { code: 403, message: 'Forbidden' }

  const media = await db
    .selectFrom('media')
    .select(['status', 'media_type'])
    .where('book_id', '=', bookId)
    .executeTakeFirst()
  if (!media || media.status !== 'READY') return { code: 404, message: 'Book analysis failed' }

  const kind = profileFor(media.media_type)
  if (kind === null) return { code: 404, message: 'Book analysis failed' }

  const series = await db
    .selectFrom('series_metadata')
    .select(['language', 'reading_direction'])
    .where('series_id', '=', row.series_id)
    .executeTakeFirst()

  const pages = await db
    .selectFrom('media_page')
    .select(['number', 'file_name', 'media_type', 'width', 'height'])
    .where('book_id', '=', bookId)
    .orderBy('number')
    .execute()

  const [book] = await buildBookDtos(db, [row as unknown as BookRow], context.user.id)

  return {
    book: book!,
    mediaType: media.media_type,
    kind,
    // An EPUB whose pages are all images is one the page reader can open too.
    divinaCompatible:
      kind === 'DIVINA' || (kind === 'EPUB' && pages.every((page) => page.media_type.startsWith('image/'))),
    series: { language: series?.language ?? null, readingDirection: series?.reading_direction ?? null },
    pages,
  }
}

/** The media type of the poster a reader should show, as a best effort. */
async function thumbnailType(db: Kysely<DB>, bookId: string): Promise<string | null> {
  const rows = await db
    .selectFrom('thumbnails')
    .select(['media_type', 'selected'])
    .where('owner_type', '=', 'BOOK')
    .where('owner_id', '=', bookId)
    .execute()
  return (rows.find((row) => row.selected === 1) ?? rows[0])?.media_type ?? null
}

async function sendManifest(
  db: Kysely<DB>,
  req: FastifyRequest<{ Params: { bookId: string } }>,
  reply: FastifyReply,
  requested: Profile | 'auto',
): Promise<FastifyReply> {
  const resolved = await resolveBook(db, req, req.params.bookId)
  if ('code' in resolved) return reply.code(resolved.code).send({ message: resolved.message })

  const build: Profile = requested === 'auto' ? resolved.kind : requested
  if ((build === 'EPUB' || build === 'PDF') && resolved.kind !== build) {
    return reply
      .code(400)
      .send({ message: `Book media type '${resolved.mediaType ?? ''}' not compatible with requested profile` })
  }

  const base = baseUrl(req)
  const resources: Link[] = [
    prune({
      href: `${base}/books/${resolved.book.id}/thumbnail`,
      type: (await thumbnailType(db, resolved.book.id)) ?? 'image/jpeg',
    }),
  ]
  const publication: Publication = {
    context: CONTEXT,
    metadata: metadataOf(resolved.book, resolved.series, resolved.pages.length, CONFORMS_TO[build]),
    links: publicationLinks(req, resolved.book.id, resolved.kind, resolved.mediaType, resolved.divinaCompatible),
    images: [],
    readingOrder: [],
    resources,
    toc: [],
    landmarks: [],
    pageList: [],
  }

  if (build === 'EPUB') {
    const resourceBase = `${base}/books/${resolved.book.id}/resource/`
    const spine = new Set(resolved.pages.map((page) => page.file_name))
    const files = await db
      .selectFrom('media_file')
      .select('file_name')
      .where('book_id', '=', resolved.book.id)
      .orderBy('file_name')
      .execute()

    publication.readingOrder = resolved.pages.map((page) =>
      prune({ href: `${resourceBase}${encodePath(page.file_name)}`, type: page.media_type }),
    )
    publication.resources = [
      ...resources,
      ...files
        .filter((file) => !spine.has(file.file_name))
        .map((file) => prune({ href: `${resourceBase}${encodePath(file.file_name)}` })),
    ]

    const toc = await db.selectFrom('epub_toc').select('toc').where('book_id', '=', resolved.book.id).executeTakeFirst()
    if (toc) publication.toc = tocLinks(JSON.parse(toc.toc) as TocEntry[], resourceBase)

    return reply.type(WEBPUB_TYPE).send(publication)
  }

  publication.readingOrder = pageReadingOrder(req, resolved.book.id, build, resolved.pages)
  return reply.type(build === 'DIVINA' ? DIVINA_TYPE : WEBPUB_TYPE).send(publication)
}

/**
 * The WebPub manifest of a book.
 *
 * A reader asks for `/manifest` and gets the one that fits the book, or names a
 * profile explicitly. The manifest describes how to read the book: the order of
 * its pages or spine, the files a reader needs alongside them, and the metadata
 * that goes with them.
 */
export async function registerManifestRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  app.get<{ Params: { bookId: string } }>('/api/v1/books/:bookId/manifest', { preHandler: requireAuth }, (req, reply) =>
    sendManifest(db, req, reply, 'auto'),
  )
  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/manifest/divina',
    { preHandler: requireAuth },
    (req, reply) => sendManifest(db, req, reply, 'DIVINA'),
  )
  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/manifest/epub',
    { preHandler: requireAuth },
    (req, reply) => sendManifest(db, req, reply, 'EPUB'),
  )
  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/manifest/pdf',
    { preHandler: requireAuth },
    (req, reply) => sendManifest(db, req, reply, 'PDF'),
  )
}
