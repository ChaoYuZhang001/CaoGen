package com.caogen.idebridge

import com.intellij.ide.ApplicationInitializedListener
import com.intellij.openapi.application.ApplicationManager

class RecorderE2EApplicationInitializedListener : ApplicationInitializedListener {
    override fun componentsInitialized() {
        if (!RecorderE2EDiagnostics.enabled()) return
        if (!RecorderE2EDiagnostics.tryBeginAutorun("applicationInitialized.triggered")) return
        BridgeInteractionRecorder.recordActionStep("applicationInitialized.triggered")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val cwd = RecorderE2EDiagnostics.workspace()
                RecorderE2ERunner.run(null, "JetBrains Application Initialized", cwd)
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
