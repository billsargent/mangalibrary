import type { Router } from 'vue-router'
import { currentUserQuery } from '@/colada/users'
import { useQueryCache } from '@pinia/colada'
import { useMessagesStore } from '@/stores/messages'
import { commonMessages } from '@/utils/i18n/common-messages'
import { logger } from '@/services/logtape'

/**
 * Check if the user has the necessary role before navigating to restricted pages.
 * The authentication is cached by Pinia Colada.
 *
 * A user who does not have the role is sent to the error page, which asks for nothing and
 * sends them nowhere by itself. Sending them to the home page instead - as this guard used
 * to - is a loop whenever the home page is itself a page they may not see: the home page
 * redirects to the library, the library asks for the role, the role is missing, and the
 * browser goes round for ever without ever rendering a page. That is not a hypothetical
 * misconfiguration: it is what a server that does not report the plain USER role gets, and
 * it took the editor's memory with it.
 */
export function useRoleGuard(router: Router) {
  router.beforeEach(async (to) => {
    if (to.meta.requiresRole) {
      const queryCache = useQueryCache()
      const entry = queryCache.ensure(currentUserQuery)
      try {
        const state = await queryCache.refresh(entry)

        if (!state.data?.roles?.includes(to.meta.requiresRole)) {
          logger.debug(
            'guard: {to} needs the role {required}, which the signed-in user does not have; showing the error page',
            { to: to.fullPath, required: to.meta.requiresRole },
          )
          useMessagesStore().messages.push(commonMessages.noPermission)
          return { name: '/error' }
        }
      } catch (ignored) {
        return { name: '/error' }
      }
    }
  })
}
