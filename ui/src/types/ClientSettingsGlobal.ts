/**
 * Settings an administrator applies to everyone who uses the server.
 *
 * The keys and the stored values are the ones the previous web interface used, so
 * a setting it saved is read here as it was.
 */
export const ClientSettingGlobal = {
  SeriesGroups: 'webui.series_groups',
} as const

export type ClientSettingGlobal = (typeof ClientSettingGlobal)[keyof typeof ClientSettingGlobal]

/** How series are grouped for navigation: each group and the characters that fall in it. */
export type SeriesGroups = {
  name: SeriesGroupsName
  groups: Record<string, string[]>
}

export const SeriesGroupsNames = ['alpha', 'japanese'] as const
export type SeriesGroupsName = (typeof SeriesGroupsNames)[number]

export const SERIES_GROUPS_ALPHA: SeriesGroups = {
  name: 'alpha',
  groups: Object.fromEntries(
    Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => [letter, [letter]]),
  ),
}

export const SERIES_GROUPS_JAPANESE: SeriesGroups = {
  name: 'japanese',
  groups: {
    あ: ['あ', 'ア'],
    い: ['い', 'イ'],
    う: ['う', 'ゔ', 'ウ', 'ヴ'],
    え: ['え', 'エ'],
    お: ['お', 'オ'],
    か: ['か', 'が', 'カ', 'ガ'],
    き: ['き', 'ぎ', 'キ', 'ギ'],
    く: ['く', 'ぐ', 'ク', 'グ'],
    け: ['け', 'げ', 'ケ', 'ゲ'],
    こ: ['こ', 'ご', 'コ', 'ゴ'],
    さ: ['さ', 'ざ', 'サ', 'ザ'],
    し: ['し', 'じ', 'シ', 'ジ'],
    す: ['す', 'ず', 'ス', 'ズ'],
    せ: ['せ', 'ぜ', 'セ', 'ゼ'],
    そ: ['そ', 'ぞ', 'ソ', 'ゾ'],
    た: ['た', 'だ', 'タ', 'ダ'],
    ち: ['ち', 'ぢ', 'チ', 'ヂ'],
    つ: ['つ', 'づ', 'ツ', 'ズ'],
    て: ['て', 'で', 'テ', 'デ'],
    と: ['と', 'ど', 'ト', 'ド'],
    な: ['な', 'ナ'],
    に: ['に', 'ニ'],
    ぬ: ['ぬ', 'ヌ'],
    ね: ['ね', 'ネ'],
    の: ['の', 'ノ'],
    は: ['は', 'ば', 'ぱ', 'ハ', 'バ', 'パ'],
    ひ: ['ひ', 'び', 'ぴ', 'ヒ', 'ビ', 'ピ'],
    ふ: ['ふ', 'ぶ', 'ぷ', 'フ', 'ブ', 'プ'],
    へ: ['へ', 'べ', 'ぺ', 'ヘ', 'ベ', 'ベ'],
    ほ: ['ほ', 'ぼ', 'ぽ', 'ホ', 'ボ', 'ポ'],
    ま: ['ま', 'マ'],
    み: ['み', 'ミ'],
    む: ['む', 'ム'],
    め: ['め', 'メ'],
    も: ['も', 'モ'],
    や: ['や', 'ヤ'],
    ゆ: ['ゆ', 'ユ'],
    よ: ['よ', 'ヨ'],
    ら: ['ら', 'ラ'],
    り: ['り', 'リ'],
    る: ['る', 'ル'],
    れ: ['れ', 'レ'],
    ろ: ['ろ', 'ロ'],
    わ: ['わ', 'ワ'],
    を: ['を', 'ヲ'],
    ん: ['ん', 'ン'],
  },
}

export const SERIES_GROUPS: Record<SeriesGroupsName, SeriesGroups> = {
  alpha: SERIES_GROUPS_ALPHA,
  japanese: SERIES_GROUPS_JAPANESE,
}
