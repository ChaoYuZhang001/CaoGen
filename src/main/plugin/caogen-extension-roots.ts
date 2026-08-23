import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export function caogenUserExtensionRoot(home = homedir()): string {
  return resolve(join(home, '.caogen'))
}

export function caogenProjectExtensionRoot(projectRoot: string): string {
  return resolve(join(resolve(projectRoot), '.caogen'))
}

export function caogenExtensionRegistryRoots(
  projectRoots: Array<string | undefined>,
  home = homedir()
): string[] {
  const roots = projectRoots
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map(caogenProjectExtensionRoot)
  roots.push(caogenUserExtensionRoot(home))
  return [...new Set(roots)]
}

export function caogenManagedPluginsRoot(home = homedir()): string {
  return join(caogenUserExtensionRoot(home), 'plugins')
}

export function isCaogenExtensionRegistryRoot(root: string, home = homedir()): boolean {
  const resolved = resolve(root)
  return resolved === caogenUserExtensionRoot(home) || basename(resolved) === '.caogen'
}
