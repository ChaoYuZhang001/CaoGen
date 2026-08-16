import { redactLogArguments } from './secret-redaction'

const INSTALL_KEY = Symbol.for('caogen.main-process-console-redaction.v1')
type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn'

const globalState = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean }

if (!globalState[INSTALL_KEY]) {
  globalState[INSTALL_KEY] = true
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const satisfies readonly ConsoleMethod[]) {
    const original = console[method].bind(console)
    console[method] = (...values: unknown[]): void => original(...redactLogArguments(values))
  }
}
