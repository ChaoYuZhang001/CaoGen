import {
  runSandboxedCommand,
  writeTextFileWithSandbox,
  type SandboxCommandOptions,
  type SandboxCommandResult,
  type SandboxFileWriteOptions
} from './docker-sandbox'

export type SystemSandboxCommandOptions = Omit<SandboxCommandOptions, 'mode'>
export type SystemSandboxFileWriteOptions = Omit<SandboxFileWriteOptions, 'mode'>

export async function runSystemSandboxedCommand(
  options: SystemSandboxCommandOptions
): Promise<SandboxCommandResult> {
  return runSandboxedCommand({ ...options, mode: 'standardSystem' })
}

export async function writeTextFileWithSystemSandbox(
  options: SystemSandboxFileWriteOptions
): Promise<SandboxCommandResult> {
  return writeTextFileWithSandbox({ ...options, mode: 'standardSystem' })
}
