import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@codemirror') || id.includes('@uiw')) {
              return 'codemirror'
            }

            if (
              id.includes('react-markdown') ||
              id.includes('remark-gfm') ||
              id.includes('remark-') ||
              id.includes('mdast') ||
              id.includes('micromark') ||
              id.includes('unified') ||
              id.includes('hast') ||
              id.includes('vfile')
            ) {
              return 'markdown'
            }

            if (id.includes('react') || id.includes('scheduler')) {
              return 'react-vendor'
            }
          }
        },
      },
    },
  },
})
