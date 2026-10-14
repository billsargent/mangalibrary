import { defineQueryOptions } from '@pinia/colada'
import { client } from '@/generated/openapi/client.gen'
import type { CloudTag } from '@/functions/tag-cloud'

/**
 * Every tag, with how many series each leads to. This server's own: it is not in
 * the API description the client is generated from, as `metrics.ts` is not.
 */
export const tagCloudQuery = defineQueryOptions(({ libraryId }: { libraryId?: string }) => ({
  key: ['tag-cloud', libraryId ?? 'all'],
  query: async () => {
    const data = await client.get<{ 200: { tags: CloudTag[] } }, unknown, true, 'data'>({
      responseStyle: 'data',
      security: [
        { scheme: 'basic', type: 'http' },
        { name: 'X-API-Key', type: 'apiKey' },
      ],
      url: '/api/v1/tags/cloud',
      query: libraryId ? { library_id: libraryId } : {},
      throwOnError: true,
    })
    return data.tags
  },
}))
