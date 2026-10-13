import { describe, expect, test } from 'vitest'
import { parseSeriesGroups, seriesGroupsUpdate } from './series-groups'
import { ClientSettingGlobal } from '@/types/ClientSettingsGlobal'
import { parseUserSettings } from './user-settings'
import { ClientSettingUser } from '@/types/ClientSettingsUser'

const stored = (value: string) => ({ [ClientSettingGlobal.SeriesGroups]: { value } })

describe('parseSeriesGroups', () => {
  test('is the alphabet when nothing is stored', () => {
    expect(parseSeriesGroups(undefined).name).toBe('alpha')
    expect(parseSeriesGroups({}).name).toBe('alpha')
    expect(Object.keys(parseSeriesGroups({}).groups)).toHaveLength(26)
  })

  test('reads what the previous interface stored', () => {
    // It stored the whole table; only the name is used.
    const legacy = JSON.stringify({ name: 'japanese', groups: { あ: ['あ'] } })
    const groups = parseSeriesGroups(stored(legacy))
    expect(groups.name).toBe('japanese')
    expect(groups.groups['か']).toEqual(['か', 'が', 'カ', 'ガ'])
  })

  test('is the alphabet when the stored value cannot be read', () => {
    expect(parseSeriesGroups(stored('not json')).name).toBe('alpha')
    expect(parseSeriesGroups(stored('null')).name).toBe('alpha')
    expect(parseSeriesGroups(stored('{"name":"klingon"}')).name).toBe('alpha')
  })

  test('reads back what it writes', () => {
    const update = seriesGroupsUpdate('japanese')
    expect(update[ClientSettingGlobal.SeriesGroups]?.allowUnauthorized).toBe(false)
    expect(parseSeriesGroups(update).name).toBe('japanese')
  })
})

describe('poster settings', () => {
  test('stretch the poster and leave it sharp when nothing is stored', () => {
    const settings = parseUserSettings(undefined)
    expect(settings[ClientSettingUser.PosterStretch]).toBe(true)
    expect(settings[ClientSettingUser.PosterBlurUnread]).toBe(false)
  })

  test('read what the previous interface stored', () => {
    const settings = parseUserSettings({
      [ClientSettingUser.PosterStretch]: { value: 'false' },
      [ClientSettingUser.PosterBlurUnread]: { value: 'true' },
    })
    expect(settings[ClientSettingUser.PosterStretch]).toBe(false)
    expect(settings[ClientSettingUser.PosterBlurUnread]).toBe(true)
  })

  test('fall back when the stored value is not a yes or a no', () => {
    const settings = parseUserSettings({
      [ClientSettingUser.PosterStretch]: { value: '"sometimes"' },
    })
    expect(settings[ClientSettingUser.PosterStretch]).toBe(true)
  })
})
