import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const source = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8')
const welcome = source('src/renderer/src/components/WelcomeView.tsx')
const quickStart = source('src/renderer/src/components/studio/VideoQuickStart.tsx')
const videoView = source('src/renderer/src/components/studio/VideoStudioView.tsx')
const videoPanel = source('src/renderer/src/components/studio/VideoStudioPanel.tsx')
const videoQuickProvider = source('src/renderer/src/components/studio/VideoProviderQuickEnable.tsx')
const project = source('src/renderer/src/components/studio/ProjectWorkspaceStudio.tsx')
const projectPicker = source('src/renderer/src/components/studio/ProjectPicker.tsx')
const projectForm = source('src/renderer/src/components/studio/ProjectWorkspaceStudioForms.tsx')
const providerList = source('src/renderer/src/components/settings/ProviderList.tsx')
const providerManager = source('src/renderer/src/components/settings/ProviderProfileManager.tsx')
const providerQuick = source('src/renderer/src/components/ProviderQuickSetup.tsx')
const providerQuickPicker = source('src/renderer/src/components/ProviderQuickPresetPicker.tsx')

const assertions = [
  [welcome.includes('data-assistant-setup-action="configure-provider"'), 'Assistant exposes an inline provider setup action'],
  [welcome.includes('onOpenSettings={onOpenSettings}'), 'Assistant setup action is wired to settings'],
  [quickStart.includes('data-video-title-optional'), 'Video title is explicitly optional'],
  [quickStart.includes('disabled={props.creating || !props.script.trim()}'), 'Video quick start only requires a script'],
  [videoView.includes('titleFromScript(productionScript, text.defaultProductionTitle)'), 'Video quick start derives a title when omitted'],
  [videoPanel.includes('titleFromScript(productionScript, text.defaultProductionTitle)'), 'Existing project video creation derives a title when omitted'],
  [videoPanel.includes('VideoProviderQuickEnableButton') && videoQuickProvider.includes('data-video-enable-default-provider') && videoQuickProvider.includes('grok-imagine-video'), 'Video exposes one-click enablement for a configured video Provider'],
  [project.indexOf('data-project-flow-step="supervisor"') < project.indexOf('data-project-flow-step="delivery"'), 'Project execution appears before delivery in the DOM'],
  [!project.includes('data-project-flow-step="supervisor" aria-labelledby="project-execution-actions-title"'), 'Execution actions do not shadow the execution flow anchor'],
  [projectForm.includes('data-project-template-details') && projectForm.includes('创建后立即输入一句话目标'), 'Project creation keeps template details collapsed and points to the first goal'],
  [project.includes('<ProjectPicker') && projectPicker.includes('data-project-workspace-select-trigger') && projectPicker.includes('data-project-workspace-select-menu') && projectPicker.includes('data-project-workspace-select'), 'Project selection uses a bounded accessible picker with a native automation bridge'],
  [providerList.includes('data-provider-empty-action'), 'Provider empty state exposes a primary add action'],
  [providerManager.indexOf('<section className="provider-compatibility-tools"') > providerManager.indexOf('{children}'), 'Provider migration tools are secondary to the provider list'],
  [providerQuick.includes('ProviderQuickPresetPicker') && providerQuickPicker.includes('data-provider-quick-preset-picker') && providerQuickPicker.includes('providerQuickSelectedPreset'), 'Provider quick setup keeps the preset catalog progressive and shows the selected service']
]

const failures = assertions.filter(([ok]) => !ok).map(([, message]) => message)
if (failures.length > 0) {
  console.error(`UX feedback repair smoke failed (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`UX feedback repair smoke passed (${assertions.length}/${assertions.length})`)
}
