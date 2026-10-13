import { useQuery } from '@pinia/colada'
import { client } from '@/generated/openapi/client.gen'
import { type Metric, statisticOf, tagValues } from '@/functions/metrics'

/** Read one metric, narrowed by `key:value` tags. Not in the generated client: it is not in the API description. */
async function getMetric(name: string, tags: string[] = []): Promise<Metric> {
  const data = await client.get<{ 200: Metric }, unknown, true, 'data'>({
    responseStyle: 'data',
    security: [
      { scheme: 'basic', type: 'http' },
      { name: 'X-API-Key', type: 'apiKey' },
    ],
    url: '/actuator/metrics/{name}',
    path: { name },
    query: { tag: tags },
    throwOnError: true,
  })
  return data
}

/** A metric with one of its statistics read for each value of a tag. */
export type MetricByTag = {
  metric: Metric
  byTag: Record<string, number | undefined>
}

async function getMetricByTag(
  name: string,
  tag: string,
  statistics: string[],
): Promise<MetricByTag[]> {
  const metric = await getMetric(name)
  const values = tagValues(metric, tag)
  const narrowed = await Promise.all(values.map((value) => getMetric(name, [`${tag}:${value}`])))
  return statistics.map((statistic) => ({
    metric,
    byTag: Object.fromEntries(
      values.map((value, index) => [value, statisticOf(narrowed[index], statistic)]),
    ),
  }))
}

/**
 * Everything the metrics page shows, read together.
 *
 * Nothing is cached: the page is opened to see what is true now, and the task
 * counts move while it is open.
 */
export function useMetrics() {
  return useQuery({
    key: () => ['metrics'],
    query: async () => {
      const [series, books, fileSize, sidecars, collections, readLists, tasks] = await Promise.all([
        getMetricByTag('komga.series', 'library', ['VALUE']),
        getMetricByTag('komga.books', 'library', ['VALUE']),
        getMetricByTag('komga.books.filesize', 'library', ['VALUE']),
        getMetricByTag('komga.sidecars', 'library', ['VALUE']),
        getMetric('komga.collections'),
        getMetric('komga.readlists'),
        getMetricByTag('komga.tasks.execution', 'type', ['COUNT', 'TOTAL_TIME']),
      ])
      return {
        series: series[0]!,
        books: books[0]!,
        fileSize: fileSize[0]!,
        sidecars: sidecars[0]!,
        collections,
        readLists,
        tasksCount: tasks[0]!,
        tasksTime: tasks[1]!,
      }
    },
    staleTime: 0,
    gcTime: 0,
  })
}
