import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/reviewflow/',
  plugins: [react()],
  server: {
    proxy: {
      '/reviewflow/api': {
        target: 'http://localhost:3001',
        rewrite: (path) => path.replace(/^\/reviewflow/, ''),
      },
    },
  },
})
