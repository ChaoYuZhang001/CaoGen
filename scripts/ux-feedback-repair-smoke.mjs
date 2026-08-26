import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const source = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8')
const welcome = source('src/renderer/src/components/WelcomeView.tsx')
const quickStart = source('src/renderer/src/components/studio/VideoQuickStart.tsx')
const videoView = source('src/renderer/src/components/studio/VideoStudioView.tsx')
const videoPanel = source('src/renderer/src/components/studio/VideoStudioPanel.tsx')
const project = source('src/renderer/src/components/studio/ProjectWorkspaceStudio.tsx')
const providerList = source('src/renderer/src/components/settings/ProviderList.tsx')
const providerManager = source('src/renderer/src/components/settings/ProviderProfileManager.tsx')

const assertions = [
  [welcome.includes('data-assistant-setup-action="configure-provider"'), 'Assistant exposes an inline provider setup action'],
  [welcome.includes('onOpenSettings={onOpenSettings}'), 'Assistant setup action is wired to settings'],
  [quickStart.includes('data-video-title-optional'), 'Video title is explicitly optional'],
  [quickStart.includes('disabled={props.creating || !props.script.trim()}'), 'Video quick start only requires a script'],
  [videoView.includes('titleFromScript(productionScript, text.defaultProductionTitle)'), 'Video quick start derives a title when omitted'],
  [videoPanel.includes('titleFromScript(productionScript, text.defaultProductionTitle)'), 'Existing project video creation derives a title when omitted'],
  [project.indexOf('data-project-flow-step="supervisor"') < project.indexOf('data-project-flow-step="delivery"'), 'Project execution appears before delivery in the DOM'],
  [!project.includes('data-project-flow-step="supervisor" aria-labelledby="project-execution-actions-title"'), 'Execution actions do not shadow the execution flow anchor'],
  [providerList.includes('data-provider-empty-action'), 'Provider empty state exposes a primary add action'],
  [providerManager.indexOf('<section className="provider-compatibility-tools"') > providerManager.indexOf('{children}'), 'Provider migration tools are secondary to the provider list']
]

const failures = assertions.filter(([ok]) => !ok).map(([, message]) => message)
if (failures.length > 0) {
  console.error(`UX feedback repair smoke failed (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`UX feedback repair smoke passed (${assertions.length}/${assertions.length})`)
}
