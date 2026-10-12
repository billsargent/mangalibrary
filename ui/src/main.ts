/**
 * main.ts
 *
 * Bootstraps Vuetify and other plugins then mounts the App`
 */

// Plugins
import { registerPlugins } from '@/plugins'
import 'virtual:uno.css'

// Components
import App from './App.vue'

// Composables
import { createApp } from 'vue'
import { initLogger } from '@/services/logtape'
import { setupOpenapiClient } from '@/api/komga-client'

await initLogger()

setupOpenapiClient()

const app = createApp(App)

registerPlugins(app)

app.mount('#app')

/**
 * An edited file reaches this module the moment it is re-imported - and re-running it mounts
 * a second app on the same element and registers every navigation guard a second time, on a
 * router that cannot have a guard taken off it. A dozen edits later every navigation runs a
 * dozen copies of every guard, and one that redirects anywhere at all turns into a storm of
 * navigation the browser cannot finish. Hot updates stop here and reload the page instead.
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate('mangalibrary: the entry point cannot be hot-reloaded')
  })
}
