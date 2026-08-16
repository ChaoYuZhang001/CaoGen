const path = require('node:path')
const { dialog } = require('electron')

const expectedToken = 'assistant-studio-live-switch-v1'
if (process.env.CAOGEN_E2E_EFFECT_RESOLUTION_TOKEN !== expectedToken) {
  throw new Error('assistant/studio live-switch Electron harness token is missing')
}

const mainEntry = process.env.CAOGEN_E2E_MAIN_ENTRY
if (!mainEntry || !path.isAbsolute(mainEntry)) {
  throw new Error('assistant/studio live-switch Electron harness requires an absolute main entry')
}

const originalShowMessageBox = dialog.showMessageBox.bind(dialog)
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1)
  if (options?.title !== '确认外部效果状态' || options?.message !== '确认该外部操作没有执行？') {
    return originalShowMessageBox(...args)
  }
  const validContract = options.buttons?.[1] === '确认未执行并允许重试' &&
    options.defaultId === 0 && options.cancelId === 0 &&
    options.checkboxLabel === '我已核对上方工具、目标和当前证据' &&
    options.checkboxChecked === false
  if (!validContract) throw new Error('unknown Effect confirmation dialog contract changed')
  process.stdout.write(`[caogen-e2e] effect resolution dialog requested: ${JSON.stringify({
    title: options.title,
    message: options.message,
    action: options.buttons[1],
    checkboxLabel: options.checkboxLabel
  })}\n`)
  return { response: 1, checkboxChecked: true }
}

require(mainEntry)
