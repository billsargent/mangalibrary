import type { Migration } from '../migrate.js'
import { migration0001ServerSettings } from './0001_server_settings.js'
import { migration0002Libraries } from './0002_libraries.js'
import { migration0003Identity } from './0003_identity.js'
import { migration0004Content } from './0004_content.js'
import { migration0005Media } from './0005_media.js'
import { migration0006Thumbnails } from './0006_thumbnails.js'
import { migration0007ProgressOrganisation } from './0007_progress_organisation.js'
import { migration0008Maintenance } from './0008_maintenance.js'
import { migration0009Search } from './0009_search.js'
import { migration0010UserRestrictions } from './0010_user_restrictions.js'
import { migration0011MetadataLocks } from './0011_metadata_locks.js'
import { migration0012ClientSettingsAllowUnauthorized } from './0012_client_settings_allow_unauthorized.js'
import { migration0013AggregationSummaryNumber } from './0013_aggregation_summary_number.js'
import { migration0014ThumbnailUrl } from './0014_thumbnail_url.js'
import { migration0015PageHash } from './0015_page_hash.js'
import { migration0016SearchSeriesTitleSort } from './0016_search_series_title_sort.js'
import { migration0017JobRequeued } from './0017_job_requeued.js'
import { migration0018ContentVersion } from './0018_content_version.js'

/**
 * Ordered migration registry, applied in id order by the runner.
 *
 * The schema deliberately differs from Komga's (see `docs/COMPATIBILITY.md`):
 * one `thumbnails` table instead of five, stored sort keys instead of custom
 * SQLite collations, and FTS5 instead of Lucene.
 */
export const migrations: Migration[] = [
  migration0001ServerSettings,
  migration0002Libraries,
  migration0003Identity,
  migration0004Content,
  migration0005Media,
  migration0006Thumbnails,
  migration0007ProgressOrganisation,
  migration0008Maintenance,
  migration0009Search,
  migration0010UserRestrictions,
  migration0011MetadataLocks,
  migration0012ClientSettingsAllowUnauthorized,
  migration0013AggregationSummaryNumber,
  migration0014ThumbnailUrl,
  migration0015PageHash,
  migration0016SearchSeriesTitleSort,
  migration0017JobRequeued,
  migration0018ContentVersion,
]
