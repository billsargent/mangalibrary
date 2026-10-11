export const USER_ROLES = [
  'ADMIN',
  'FILE_DOWNLOAD',
  'PAGE_STREAMING',
  'KOBO_SYNC',
  'KOREADER_SYNC',
] as const

export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value)
}

export type AllowExclude = 'ALLOW_ONLY' | 'EXCLUDE'

export interface AgeRestriction {
  age: number
  restriction: AllowExclude
}

/**
 * Content restrictions, mirroring Komga:
 * a series is visible when `(ageAllowed || labelAllowed) && ageDenied && labelDenied`.
 */
export interface ContentRestrictions {
  ageRestriction: AgeRestriction | null
  labelsAllow: string[]
  labelsExclude: string[]
}

export const NO_RESTRICTIONS: ContentRestrictions = {
  ageRestriction: null,
  labelsAllow: [],
  labelsExclude: [],
}

/** A user as needed for authorisation decisions. */
export interface AuthUser {
  id: string
  email: string
  roles: UserRole[]
  sharedAllLibraries: boolean
  sharedLibraryIds: string[]
  restrictions: ContentRestrictions
}
