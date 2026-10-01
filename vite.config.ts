import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // tests/tokens.test.ts reads tokens.css as text; Vitest blanks CSS it does not include.
    css: { include: [/tokens\.css/] },
  },
})
