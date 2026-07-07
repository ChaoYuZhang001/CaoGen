package com.caogen.idebridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PreloadingActivity

class RecorderE2EPreloadingActivity : PreloadingActivity() {
    override fun preload() {
        if (!RecorderE2EDiagnostics.enabled()) return
        RecorderE2EDiagnostics.recordMarker("preloadingActivity.triggered")
        BridgeInteractionRecorder.recordActionStep("preloadingActivity.triggered")
        ApplicationManager.getApplication().invokeLater {
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    if (!RecorderE2EDiagnostics.tryBeginAutorun("preloadingActivity.deferred")) return@executeOnPooledThread
                    val cwd = RecorderE2EDiagnostics.workspace()
                    RecorderE2ERunner.run(null, "JetBrains Preloading Activity", cwd)
                } catch (error: Throwable) {
                    val message = error.message ?: error.javaClass.name
                    RecorderE2EDiagnostics.recordMarker("autorun.failed", mapOf("error" to message))
                    BridgeInteractionRecorder.recordActionStep("autorun.failed", mapOf("error" to message))
                } finally {
                    RecorderE2EDiagnostics.exitIfRequested()
                }
            }
        }
    }
}
