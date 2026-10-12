import type { Router } from 'vue-router'
import { currentUserQuery } from '@/colada/users'
import { useQueryCache } from '@pinia/colada'
import { isApiErrorWithCause } from '@/api/komga-client'
import { logger } from '@/services/logtape'

/**
 * Check if the user is authenticated before navigating to any page.
 * The authentication is cached by Pinia Colada.
 * Redirect to the startup page if not authenticated.
 */
export function useLoginGuard(router: Router) {
  router.beforeEach(async (to) => {
    if (!to.meta.noAuth) {
      const queryCache = useQueryCache()
      const entry = queryCache.ensure(currentUserQuery)
      try {
        const state = await queryCache.refresh(entry)

        const isAuthenticated = !!state.data
        logger.debug('guard: {to} - authenticated={isAuthenticated}', {
          to: to.fullPath,
          isAuthenticated,
        })

        if (!isAuthenticated) {
          const query = Object.assign(
            {},
            to.query,
            to.fullPath !== '/' ? { redirect: to.fullPath } : {},
          )
          logger.debug('guard: {to} - no current user, going to the startup page', {
            to: to.fullPath,
          })
          return { name: '/startup', query: query }
        }
      } catch (e) {
        // A refusal here is what a browser that was not given a usable session sees, and
        // it is the whole story of a sign-in that appeared to do nothing: the page it was
        // sent to came back to the login page without saying why.
        if (isApiErrorWithCause(e) && e.cause.status === 401) {
          logger.debug(
            'guard: {to} - the current user request was refused (401), going to the login page',
            {
              to: to.fullPath,
            },
          )
          return { name: '/login' }
        }
        logger.debug('guard: {to} - the current user request failed with {error}', {
          to: to.fullPath,
          error: String(e),
        })
        return { name: '/error' }
      }
    }
  })
}
