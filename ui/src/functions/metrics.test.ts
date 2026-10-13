import { describe, expect, test } from 'vitest'
import { type Metric, metricBars, statisticOf, tagValues } from './metrics'

const tasks: Metric = {
  name: 'komga.tasks.execution',
  baseUnit: 'seconds',
  measurements: [
    { statistic: 'COUNT', value: 3 },
    { statistic: 'TOTAL_TIME', value: 2 },
  ],
  availableTags: [{ tag: 'type', values: ['AnalyzeBook', 'ScanLibrary'] }],
}

describe('reading a metric', () => {
  test('finds a statistic, and says when there is none', () => {
    expect(statisticOf(tasks, 'COUNT')).toBe(3)
    expect(statisticOf(tasks, 'VALUE')).toBeUndefined()
    expect(statisticOf(undefined, 'COUNT')).toBeUndefined()
  })

  test('lists what a tag can be narrowed to', () => {
    expect(tagValues(tasks, 'type')).toEqual(['AnalyzeBook', 'ScanLibrary'])
    expect(tagValues(tasks, 'library')).toEqual([])
    expect(tagValues(undefined, 'type')).toEqual([])
  })
})

describe('metricBars', () => {
  test('puts the largest first and measures the rest against it', () => {
    expect(metricBars({ a: 50, b: 200, c: 100 })).toEqual([
      { key: 'b', label: 'b', value: 200, percent: 100 },
      { key: 'c', label: 'c', value: 100, percent: 50 },
      { key: 'a', label: 'a', value: 50, percent: 25 },
    ])
  })

  test('names bars with the label given, and orders ties by it', () => {
    const names: Record<string, string> = { L1: 'Manga', L2: 'Comics' }
    expect(
      metricBars({ L1: 4, L2: 4 }, (key) => names[key] ?? key).map((bar) => bar.label),
    ).toEqual(['Comics', 'Manga'])
  })

  test('keeps a bar for nothing, without dividing by it', () => {
    expect(metricBars({ a: 0, b: undefined })).toEqual([
      { key: 'a', label: 'a', value: 0, percent: 0 },
      { key: 'b', label: 'b', value: 0, percent: 0 },
    ])
    expect(metricBars({})).toEqual([])
  })
})
