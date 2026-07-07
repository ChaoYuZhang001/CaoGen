package com.caogen.idebridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import java.time.Instant

class RecorderE2EStartupActivity : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        if (!RecorderE2EDiagnostics.enabled()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                runRecorderE2E(project)
            } catch (error: Throwable) {
                BridgeInteractionRecorder.recordActionStep(
                    "autorun.failed",
                    mapOf("error" to (error.message ?: error.javaClass.name))
                )
                RecorderE2EDiagnostics.recordMarker(
                    "autorun.failed",
                    mapOf("error" to (error.message ?: error.javaClass.name))
                )
            } finally {
                RecorderE2EDiagnostics.exitIfRequested()
            }
        }
    }

    private fun runRecorderE2E(project: Project) {
        if (!RecorderE2EDiagnostics.tryBeginAutorun(
            "startupActivity.triggered",
            mapOf("project" to project.name, "timestamp" to Instant.now().toString())
        )) return
        BridgeInteractionRecorder.recordActionStep(
            "startupActivity.triggered",
            mapOf("project" to project.name, "timestamp" to Instant.now().toString())
        )
        val cwd = project.basePath ?: System.getProperty("user.dir")
        RecorderE2ERunner.run(project, project.name, cwd)
    }
}
