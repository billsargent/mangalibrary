import type { PageLayout, ReaderPage } from '@/types/reader'

/** A page wider than it is tall: a double-page spread scanned as one image. */
export function isPageLandscape(page: Pick<ReaderPage, 'width' | 'height'>): boolean {
  return (page.width ?? 0) > (page.height ?? 0)
}

/** The empty half beside a page that has no partner, sized like that page. */
function blankBeside(page: ReaderPage): ReaderPage {
  return {
    number: 0,
    url: '',
    blank: true,
    mediaType: '',
    fileName: '',
    width: page.width,
    height: page.height,
  }
}

/**
 * Group pages into what the paged reader shows at once.
 *
 * - `SINGLE_PAGE`: one page at a time.
 * - `DOUBLE_PAGES`: pages in pairs, the way a printed book lies open. The first page
 *   is the cover and the last the back cover, so each stands alone, on the side it
 *   would be on in print.
 * - `DOUBLE_NO_COVER`: pairs from the very first page.
 *
 * A landscape page is already two pages wide and is never paired. The page before
 * one gets a blank partner rather than being left to pair with the page after it,
 * which would put every later pair out of step.
 */
export function buildSpreads(pages: readonly ReaderPage[], layout: PageLayout): ReaderPage[][] {
  if (pages.length === 0) return []
  if (layout === 'SINGLE_PAGE') return pages.map((page) => [page])

  const spreads: ReaderPage[][] = []
  const rest = [...pages]
  let last: ReaderPage[] | undefined

  if (layout === 'DOUBLE_PAGES') {
    const first = rest.shift()!
    spreads.push(isPageLandscape(first) ? [first] : [blankBeside(first), first])

    const back = rest.pop()
    if (back) last = isPageLandscape(back) ? [back] : [back, blankBeside(back)]
  }

  while (rest.length > 0) {
    const page = rest.shift()!
    if (isPageLandscape(page)) {
      spreads.push([page])
      continue
    }

    const next = rest.shift()
    if (next === undefined) {
      spreads.push([page, blankBeside(page)])
    } else if (isPageLandscape(next)) {
      spreads.push([page, blankBeside(page)])
      spreads.push([next])
    } else {
      spreads.push([page, next])
    }
  }

  if (last) spreads.push(last)
  return spreads
}

/** The spread a page is in, or the first one when the page is not in the book. */
export function spreadIndexOf(spreads: readonly ReaderPage[][], pageNumber: number): number {
  const index = spreads.findIndex((spread) => spread.some((page) => page.number === pageNumber))
  return index === -1 ? 0 : index
}

/**
 * The page a spread stands for: the one reading progress is recorded against.
 *
 * It is the last real page of the spread, so that turning to the final spread of a
 * book marks its final page - and with it the book - as read.
 */
export function pageOfSpread(spread: readonly ReaderPage[]): number {
  const real = spread.filter((page) => !page.blank)
  return real[real.length - 1]?.number ?? 1
}
