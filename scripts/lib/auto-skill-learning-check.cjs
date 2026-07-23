const fs = require('node:fs')
const path = require('node:path')

function createAutoSkillLearningCheck({
  M,
  settingsMod,
  mkRepo,
  fakeWindow,
  fakeWindows,
  sdkLog,
  waitFor,
  assert,
  eq
}) {
  return async () => {
    const sm = M('main/sessionManager.js').sessionManager
    const lifecycle = M('main/learning/learning-lifecycle.js')
    const learningStore = M('main/learning/learning-store.js')
    const learningSecurity = M('main/learning/learning-security.js')
    const previousSettings = { ...settingsMod.getSettings() }
    settingsMod.updateSettings({
      autoSkillLearningEnabled: true,
      failoverEnabled: false,
      budgetUsdPerSession: 0
    })
    const projectDir = mkRepo('p2-auto-skill-loop')
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    const createdIds = []
    await sm.init()
    const learningRoot = await learningStore.resolveDefaultLearningRoot(projectDir)
    const skillDrafts = () => learningStore.readLearningStateSync(learningRoot, projectDir).records
      .filter((record) => record.kind === 'skill' && record.status === 'draft')
    const skillFiles = () => findSkillFiles(path.join(projectDir, '.caogen', 'skills'))

    try {
      const meta = await sm.create({
        cwd: projectDir,
        isolated: false,
        engine: 'claude',
        providerId: 'prov-b',
        model: 'm-b',
        title: 'Tailwind Config Learning Loop'
      })
      createdIds.push(meta.id)
      await waitFor(() => sm.get(meta.id)?.meta.sdkSessionId, 3000, 'wait auto skill session init')
      sm.send(
        meta.id,
        [
          'Add Tailwind configuration to a TypeScript frontend project.',
          'Reusable workflow: inspect package.json, create tailwind.config.ts, create postcss.config.js, run npm.cmd run typecheck, then run npm.cmd run build.',
          'Persist this as a reusable Tailwind configuration workflow after the task succeeds.'
        ].join('\n')
      )
      await waitFor(() => skillDrafts().length > 0, 30000, 'wait auto skill draft')
      const draft = skillDrafts()[0]
      assert(draft.payload.type === 'skill', 'auto review should persist a Skill draft')
      assert(draft.payload.markdown.includes('Tailwind Config Learning Loop'), 'draft should keep task title')
      eq(skillFiles().length, 0, 'unapproved auto Skill must not materialize SKILL.md')

      await lifecycle.approveLearningDraft(
        projectDir,
        learningRoot,
        draft.id,
        learningSecurity.createTrustedUserLearningDecision('itest:auto-skill:approve')
      )
      await waitFor(() => skillFiles().length > 0, 30000, 'wait approved auto skill file')
      const skillPath = skillFiles()[0]
      const skillText = fs.readFileSync(skillPath, 'utf8')
      assert(skillText.includes('Tailwind Config Learning Loop'), 'approved skill should keep task title')
      assert(skillPath.startsWith(path.join(projectDir, '.caogen', 'skills')), 'stored skill must stay under project skill root')

      const beforeSecond = sdkLog.length
      sm.send(meta.id, 'Please add Tailwind config to another frontend project and reuse the local workflow.')
      await waitFor(() => sdkLog.slice(beforeSecond).some((entry) => typeof entry.promptText === 'string'), 3000, 'wait second prompt')
      const secondPrompt = sdkLog
        .slice(beforeSecond)
        .filter((entry) => typeof entry.promptText === 'string')
        .map((entry) => entry.promptText)
        .join('\n')
      assert(secondPrompt.includes('Tailwind Config Learning Loop'), 'next similar turn should inject generated skill')
      assert(secondPrompt.includes('## Current User Request'), 'injected skill prompt should preserve user request boundary')
    } finally {
      await Promise.all(createdIds.reverse().map((id) => sm.close(id)))
      const index = fakeWindows.indexOf(win)
      if (index !== -1) fakeWindows.splice(index, 1)
      settingsMod.updateSettings({
        autoSkillLearningEnabled: previousSettings.autoSkillLearningEnabled,
        failoverEnabled: previousSettings.failoverEnabled,
        budgetUsdPerSession: previousSettings.budgetUsdPerSession
      })
    }
  }
}

function findSkillFiles(root) {
  const out = []
  const stack = fs.existsSync(root) ? [root] : []
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name === 'SKILL.md') out.push(full)
    }
  }
  return out
}

module.exports = { createAutoSkillLearningCheck }
