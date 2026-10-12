<template>
  <v-form
    ref="form"
    :disabled="isLoading"
    @submit.prevent="submitForm()"
  >
    <v-container max-width="400px">
      <v-row class="justify-center">
        <v-col
          cols="7"
          sm="10"
        >
          <AppName large />
        </v-col>
      </v-row>

      <v-row>
        <v-col>
          <v-text-field
            v-model="username"
            :label="
              $formatMessage({
                description: 'Login screen: email field label',
                defaultMessage: 'Email',
                id: 'QIr0z7',
              })
            "
            autofocus
            :rules="[rules.required(), rules.email()]"
          />
        </v-col>
      </v-row>

      <v-row>
        <v-col>
          <v-text-field
            v-model="password"
            :label="
              $formatMessage({
                description: 'Login screen: password field label',
                defaultMessage: 'Password',
                id: '5AAGkA',
              })
            "
            type="password"
            :rules="[rules.required()]"
            :error-messages="loginError"
            @update:model-value="loginError = ''"
          />
        </v-col>
      </v-row>

      <v-row>
        <v-col class="py-0">
          <v-checkbox
            v-model="appStore.rememberMe"
            :label="
              $formatMessage({
                description: 'Login screen: Remember Me checkbox',
                defaultMessage: 'Remember Me',
                id: '0YG9GQ',
              })
            "
            hide-details
          />
        </v-col>
      </v-row>

      <v-row>
        <v-col>
          <v-btn
            :text="
              $formatMessage({
                description: 'Login screen: Sign In button',
                defaultMessage: 'Sign in',
                id: '02SRax',
              })
            "
            :loading="isLoading"
            type="submit"
            block
          />
        </v-col>
      </v-row>

      <v-divider class="my-4" />

      <v-row class="justify-center">
        <v-col cols="auto">
          <div class="d-flex ga-4">
            <LocaleSelector />
            <ThemeSelector />
          </div>
        </v-col>
      </v-row>
    </v-container>
  </v-form>
</template>

<script lang="ts" setup>
import { isApiErrorWithCause } from '@/api/komga-client'
import { useMessagesStore } from '@/stores/messages'
import { useIntl } from 'vue-intl'
import { commonMessages } from '@/utils/i18n/common-messages'
import { useAppStore } from '@/stores/app'
import { currentUserQuery, useLogin } from '@/colada/users'
import { useQueryCache } from '@pinia/colada'
import { logger } from '@/services/logtape'
import { useRules } from 'vuetify'

const messagesStore = useMessagesStore()
const intl = useIntl()
const appStore = useAppStore()
const queryCache = useQueryCache()
const rules = useRules()

const form = ref()
const username = ref('')
const password = ref('')
const loginError = ref<string>('')
const isLoading = ref(false)

const router = useRouter()
const route = useRoute()

const { mutateAsync: performLogin } = useLogin()

async function submitForm() {
  const { valid } = await form.value.validate()
  logger.debug('sign-in: submit (valid={valid}, rememberMe={rememberMe})', {
    valid,
    rememberMe: appStore.rememberMe,
  })
  if (!valid) return

  isLoading.value = true
  loginError.value = ''
  logger.debug('sign-in: sending {username} to the server', { username: username.value })

  try {
    // Credentials once, with the header that says a browser is asking, and the server
    // answers with the session cookie everything after this is authenticated by.
    await performLogin({
      username: username.value,
      password: password.value,
      rememberMe: appStore.rememberMe,
    })
    logger.debug('sign-in: the server accepted the credentials')

    // Accepted is not the same as signed in: the pages that follow carry the cookie and
    // nothing else, so check that it is one the server knows before leaving this page.
    // Without this the guard does the same check on the way to the app and, when it
    // fails, quietly walks the browser back here - which looked like a button that did
    // nothing at all.
    const kept = await sessionIsKept()
    if (!kept) {
      logger.debug('sign-in: the browser holds no session the server knows, staying put')
      loginError.value = intl.formatMessage(commonMessages.sessionNotKept)
      return
    }

    logger.debug('sign-in: the session is live, leaving the login page')
    const redirect = route.query.redirect?.toString()
    await router.push(redirect ?? '/')
  } catch (error) {
    const status = isApiErrorWithCause(error) ? error.cause.status : undefined
    logger.debug('sign-in: failed with {status}', { status })
    if (status === 401)
      loginError.value = intl.formatMessage({
        description: 'Login screen: error message displayed when login failed',
        defaultMessage: 'Invalid login or password',
        id: 'AjWlka',
      })
    else if (isApiErrorWithCause(error))
      messagesStore.messages.push(error.cause.message ?? commonMessages.networkError)
    else messagesStore.messages.push(commonMessages.networkError)
  } finally {
    // Whatever happened, the button stops spinning: a sign-in that neither finishes nor
    // reports must not leave the page frozen.
    isLoading.value = false
  }
}

/**
 * Ask the server who we are, with the cookie alone - the request every page after this
 * one makes. `refresh` rejects when the answer is a refusal, and the current user that
 * the sign-in itself put in the cache is not evidence that the session was kept.
 */
async function sessionIsKept(): Promise<boolean> {
  try {
    const state = await queryCache.refresh(queryCache.ensure(currentUserQuery))
    return !!state.data
  } catch (error) {
    logger.debug('sign-in: confirming the session failed with {error}', { error: String(error) })
    return false
  }
}
</script>

<route lang="yaml">
meta:
  layout: single
  noAuth: true
</route>
