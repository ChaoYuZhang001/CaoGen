package com.caogen.idebridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationStarter

class RecorderE2EApplicationStarter : ApplicationStarter {
    override val commandName: String = "caogenRecorderE2E"

    override val isHeadless: Boolean = true

    override fun main(args: List<String>) {
        try {
            val cwd = args.getOrNull(1)
                ?: System.getenv("CAOGEN_JETBRAINS_WORKSPACE")
                ?: System.getProperty("user.dir")
            if (!RecorderE2EDiagnostics.tryBeginAutorun(
                "appStarter.triggered",
                mapOf("command" to commandName, "cwd" to cwd)
            )) return
            BridgeInteractionRecorder.recordActionStep(
                "appStarter.triggered",
                mapOf("command" to commandName, "cwd" to cwd)
            )
            RecorderE2ERunner.run(null, "JetBrains App Starter", cwd)
        } catch (error: Throwable) {
            BridgeInteractionRecorder.recordActionStep(
                "autorun.failed",
                mapOf("error" to (error.message ?: error.javaClass.name))
            )
            RecorderE2EDiagnostics.recordMarker(
                "autorun.failed",
                mapOf("error" to (error.message ?: error.javaClass.name))
            )
            throw error
        } finally {
            // 命令行 E2E 是显式触发的测试入口，完成后退出避免 CI 悬挂。
            ApplicationManager.getApplication().exit(false, true, false)
        }
    }
}
