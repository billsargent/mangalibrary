/** One metric as the server reports it, which is the shape the reference gives too. */
export type Metric = {
  name: string
  description?: string
  baseUnit?: string
  measurements: { statistic: string; value: number }[]
  availableTags: { tag: string; values: string[] }[]
}

/** A bar on a chart: what it is, how much, and how it compares with the largest. */
export type MetricBar = {
  key: string
  label: string
  value: number
  /** 0 to 100, against the largest value shown. */
  percent: number
}

/** One statistic of a metric, or `undefined` when it does not report it. */
export function statisticOf(metric: Metric | undefined, statistic: string): number | undefined {
  return metric?.measurements.find((measurement) => measurement.statistic === statistic)?.value
}

/** The values a metric can be narrowed to for a tag, which is none when it has no such tag. */
export function tagValues(metric: Metric | undefined, tag: string): string[] {
  return metric?.availableTags.find((available) => available.tag === tag)?.values ?? []
}

/**
 * Bars for a set of values, largest first.
 *
 * Ties keep the order of their labels, so a chart of equal values does not shuffle
 * between two visits. A value of zero is still a bar: an empty library belongs on
 * the chart.
 */
export function metricBars(
  values: Record<string, number | undefined>,
  label: (key: string) => string = (key) => key,
): MetricBar[] {
  const rows = Object.entries(values).map(([key, value]) => ({
    key,
    label: label(key),
    value: value ?? 0,
  }))
  const largest = Math.max(0, ...rows.map((row) => row.value))
  return rows
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .map((row) => ({ ...row, percent: largest > 0 ? (row.value / largest) * 100 : 0 }))
}
