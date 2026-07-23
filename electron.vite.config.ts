import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __CAOGEN_APP_VERSION__: JSON.stringify(packageJson.version)
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    build: {
      minify: 'esbuild'
    }
  }
})
