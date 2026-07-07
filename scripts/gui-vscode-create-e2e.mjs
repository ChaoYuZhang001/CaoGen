#!/usr/bin/env node

process.env.CAOGEN_GUI_VSCODE_E2E = '1'
process.env.CAOGEN_GUI_VSCODE_CREATE_E2E = '1'
process.env.CAOGEN_GUI_VSCODE_CDP_INPUT_E2E = process.env.CAOGEN_GUI_VSCODE_CDP_INPUT_E2E ?? '1'

await import('./gui-vscode-e2e.mjs')
