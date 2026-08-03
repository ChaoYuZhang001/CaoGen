import { spawn, spawnSync } from 'node:child_process'

export function spawnElectronTestProcess(command, args, options) {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32'
  })
}

export async function terminateElectronTestProcess(child) {
  const result = { code: child.exitCode, signal: child.signalCode }
  signalProcessTree(child, 'SIGTERM')
  if (child.exitCode === null) {
    const exited = await waitForExit(child, 3_000)
    result.code = exited.code
    result.signal = exited.signal
    if (exited.timedOut) {
      signalProcessTree(child, 'SIGKILL')
      result.signal = 'SIGKILL'
    }
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
  return result
}

function signalProcessTree(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    child.kill(signal)
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: child.exitCode, signal: child.signalCode, timedOut: true }), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut: false })
    })
  })
}
