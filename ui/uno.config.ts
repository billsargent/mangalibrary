import { defineConfig, presetIcons } from 'unocss'

export default defineConfig({
  content: {
    pipeline: {
      include: [
        // Retain the default file types
        /\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/,
        // Add a glob pattern to include your js/ts files
        'src/**/*.{js,ts}',
      ],
      // You can also explicitly exclude files if needed
      // exclude: ['src/ignored-folder/**/*']
    },
  },
  presets: [
    presetIcons({
      // Name the icon sets instead of leaving them to be found. The preset finds
      // installed sets by itself only when it thinks it is not inside an editor:
      // it looks for `VSCODE_CWD`, which is also set for anything VS Code starts -
      // an extension, a task, an agent. A build run from one of those then holds no
      // icon at all, and says nothing about it.
      collections: {
        mdi: () => import('@iconify-json/mdi/icons.json').then((set) => set.default),
        tabler: () => import('@iconify-json/tabler/icons.json').then((set) => set.default),
      },
      // ensures proper CSS layers for icon colors
      processor(props) {
        delete props.color
      },
    }),
  ],
})
