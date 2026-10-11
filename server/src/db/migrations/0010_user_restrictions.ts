import type { Migration } from '../migrate.js'

/**
 * Faithful content restrictions.
 *
 * Komga stores an age restriction plus an ALLOW_ONLY/EXCLUDE mode, and labels
 * with a per-label allow flag (`USER_SHARING.ALLOW`). An earlier migration here
 * collapsed both into a single age column and a label list, which cannot express
 * allow-labels or EXCLUDE mode, so this migration replaces them.
 */
export const migration0010UserRestrictions: Migration = {
  id: '0010_user_restrictions',
  up: async (db) => {
    await db.schema.alterTable('users').addColumn('age_restriction_allow_only', 'integer').execute()

    await db.schema
      .createTable('user_sharing')
      .ifNotExists()
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('allow', 'integer', (col) => col.notNull())
      .addColumn('label', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__user_sharing', ['user_id', 'label'])
      .execute()

    await db.schema.alterTable('users').dropColumn('sharing_labels').execute()
  },
}
