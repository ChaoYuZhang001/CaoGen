import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'highlight.js/styles/github-dark.css'
import './styles.css'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
