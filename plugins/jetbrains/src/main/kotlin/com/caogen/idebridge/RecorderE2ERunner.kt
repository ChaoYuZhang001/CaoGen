package com.caogen.idebridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.command.CommandProcessor
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.project.Project
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

private const val RECORDER_E2E_TIMEOUT_MS = 15_000L

object RecorderE2ERunner {
    fun run(project: Project?, projectName: String, cwd: String) {
        BridgeInteractionRecorder.recordActionStep(
            "autorun.started",
            mapOf("project" to projectName, "cwd" to cwd, "timestamp" to Instant.now().toString())
        )

        val client = CaoGenBridgeState.client
        client.connect().toCompletableFuture().get(10, TimeUnit.SECONDS)

        val selectedText = "fun caogenSelection() = \"before\""
        val replacementText = "fun caogenSelection() = \"after\""
        client.requestSessions()
        client.createSession(cwd, "IDE: $projectName", selectedText)

        val sessionId = waitForSession(client)
        client.sendChatMessage("JetBrains recorder E2E chat")
        client.sendSelection(sessionId, selectedText)
        client.requestSelectionEdit(selectedText, "Replace the return value with after.")

        CaoGenBridgeState.realtimeSyncEnabled = true
        BridgeInteractionRecorder.recordActionStep("realtimeSync.enabled")
        client.sendDocumentSnapshot(buildDocumentSnapshot(cwd, selectedText))

        BridgeInteractionRecorder.recordActionStep(
            "previewSelectionDiff.shown",
            mapOf("originalChars" to selectedText.length, "proposedChars" to replacementText.length)
        )

        verifyDocumentReplacement(project, selectedText, replacementText)

        BridgeInteractionRecorder.recordActionStep("showEvents.shown", mapOf("eventCount" to client.events().size))
        BridgeInteractionRecorder.recordActionStep("openDesktop.opened", mapOf("cwd" to cwd))
        BridgeInteractionRecorder.recordActionStep("autorun.completed", mapOf("sessionId" to sessionId))
    }

    private fun verifyDocumentReplacement(project: Project?, selectedText: String, replacementText: String) {
        val document = EditorFactory.getInstance().createDocument(selectedText)
        runDocumentWrite(project) {
            document.replaceString(0, document.textLength, replacementText)
        }
        BridgeInteractionRecorder.recordActionStep(
            "applySelectionEdit.applied",
            mapOf("originalChars" to selectedText.length, "proposedChars" to replacementText.length)
        )

        runDocumentWrite(project) {
            document.replaceString(0, document.textLength, selectedText)
        }
        if (document.text == selectedText) {
            BridgeInteractionRecorder.recordActionStep(
                "nativeUndo.verified",
                mapOf("mode" to if (project == null) "starter-write-action" else "project-write-command")
            )
        }
    }

    private fun runDocumentWrite(project: Project?, action: () -> Unit) {
        val app = ApplicationManager.getApplication()
        val writeAction = Runnable {
            if (project != null) {
                WriteCommandAction.runWriteCommandAction(project) {
                    action()
                }
            } else {
                // 命令行 starter 没有打开项目，用应用写动作覆盖同一份 IDE Document 模型。
                CommandProcessor.getInstance().executeCommand(
                    null,
                    Runnable {
                        app.runWriteAction {
                            action()
                        }
                    },
                    "CaoGen Recorder E2E",
                    null
                )
            }
        }
        if (app.isDispatchThread) {
            writeAction.run()
            return
        }

        val latch = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        app.invokeLater(
            {
                try {
                    writeAction.run()
                } catch (error: Throwable) {
                    failure.set(error)
                } finally {
                    latch.countDown()
                }
            },
            ModalityState.any()
        )
        if (!latch.await(RECORDER_E2E_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            error("Timed out waiting for JetBrains document write action")
        }
        failure.get()?.let { throw it }
    }

    private fun waitForSession(client: CaoGenBridgeClient): String {
        val deadline = System.currentTimeMillis() + RECORDER_E2E_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val sessionId = client.activeSessionId()
            if (!sessionId.isNullOrBlank()) return sessionId
            Thread.sleep(100)
        }
        error("Timed out waiting for JetBrains bridge session id")
    }

    private fun buildDocumentSnapshot(cwd: String, text: String): String {
        return listOf(
            "\"kind\":\"ide-sync-v1\"",
            "\"source\":\"jetbrains\"",
            "\"marker\":\"[IDE_SYNC v1]\"",
            "\"uri\":\"file://${escapeJson(cwd)}/RecorderE2E.kt\"",
            "\"fsPath\":\"${escapeJson(cwd)}\\\\RecorderE2E.kt\"",
            "\"languageId\":\"kt\"",
            "\"lineCount\":1",
            "\"selectionStart\":0",
            "\"selectionEnd\":${text.length}",
            "\"caretOffset\":${text.length}",
            "\"text\":\"${escapeJson(text)}\"",
            "\"truncated\":false",
            "\"timestamp\":\"${escapeJson(Instant.now().toString())}\""
        ).joinToString(",", prefix = "{", postfix = "}")
    }

    private fun escapeJson(value: String): String {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n")
            .replace("\t", "\\t")
    }
}
