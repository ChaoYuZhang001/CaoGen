package com.caogen.idebridge

import com.intellij.diff.DiffManager
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

private const val IDE_SYNC_MARKER = "[IDE_SYNC v1]"
private const val IDE_SYNC_DEBOUNCE_MS = 750L
private const val IDE_SYNC_TEXT_LIMIT = 20_000

object CaoGenBridgeState {
    val client: CaoGenBridgeClient = CaoGenBridgeClient()
    var pendingEdit: PendingSelectionEdit? = null
    @Volatile
    var realtimeSyncEnabled: Boolean = false
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "caogen-jetbrains-ide-sync").apply { isDaemon = true }
    }
    private var syncDocument: Document? = null
    private var syncEditor: Editor? = null
    private var syncListener: DocumentListener? = null
    private var syncFuture: ScheduledFuture<*>? = null
    private var lastSyncKey: String = ""

    init {
        client.addSessionReadyListener {
            scheduleCurrentDocumentSync()
        }
    }

    @Synchronized
    fun attachDocumentSync(editor: Editor?) {
        if (!realtimeSyncEnabled || editor == null) {
            BridgeInteractionRecorder.recordBridgeStep(
                "sync.attach.skipped",
                mapOf("realtimeSyncEnabled" to realtimeSyncEnabled, "hasEditor" to (editor != null))
            )
            return
        }
        val file = FileDocumentManager.getInstance().getFile(editor.document)
        if (file == null) {
            BridgeInteractionRecorder.recordBridgeStep("sync.attach.skipped", mapOf("reason" to "missingFile"))
            return
        }
        if (!file.isInLocalFileSystem) {
            BridgeInteractionRecorder.recordBridgeStep("sync.attach.skipped", mapOf("reason" to "nonLocalFile", "uri" to file.url))
            return
        }
        if (syncDocument === editor.document) {
            syncEditor = editor
            BridgeInteractionRecorder.recordBridgeStep("sync.attach.reused", mapOf("path" to file.path))
            scheduleDocumentSync(editor.document)
            return
        }
        detachDocumentSync()
        syncDocument = editor.document
        syncEditor = editor
        val listener = object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (event.document === syncDocument) scheduleDocumentSync(event.document)
            }
        }
        editor.document.addDocumentListener(listener)
        syncListener = listener
        BridgeInteractionRecorder.recordBridgeStep("sync.attach.created", mapOf("path" to file.path))
        scheduleDocumentSync(editor.document)
    }

    @Synchronized
    fun detachDocumentSync() {
        val hadDocument = syncDocument != null
        syncFuture?.cancel(false)
        syncFuture = null
        syncListener?.let { listener ->
            syncDocument?.removeDocumentListener(listener)
        }
        syncListener = null
        syncDocument = null
        syncEditor = null
        lastSyncKey = ""
        BridgeInteractionRecorder.recordBridgeStep("sync.detach", mapOf("hadDocument" to hadDocument))
    }

    @Synchronized
    fun scheduleCurrentDocumentSync() {
        BridgeInteractionRecorder.recordBridgeStep("sync.schedule.current", mapOf("hasDocument" to (syncDocument != null)))
        syncDocument?.let { scheduleDocumentSync(it) }
    }

    @Synchronized
    private fun scheduleDocumentSync(document: Document) {
        if (!realtimeSyncEnabled || syncDocument !== document) {
            BridgeInteractionRecorder.recordBridgeStep(
                "sync.schedule.skipped",
                mapOf("realtimeSyncEnabled" to realtimeSyncEnabled, "isAttachedDocument" to (syncDocument === document))
            )
            return
        }
        syncFuture?.cancel(false)
        syncFuture = scheduler.schedule({ sendDocumentSync(document) }, IDE_SYNC_DEBOUNCE_MS, TimeUnit.MILLISECONDS)
        BridgeInteractionRecorder.recordBridgeStep("sync.schedule.debounced", mapOf("delayMs" to IDE_SYNC_DEBOUNCE_MS))
    }

    private fun sendDocumentSync(document: Document) {
        val editor = syncEditor
        if (editor == null) {
            BridgeInteractionRecorder.recordBridgeStep("sync.send.skipped", mapOf("reason" to "missingEditor"))
            return
        }
        if (!realtimeSyncEnabled || syncDocument !== document) {
            BridgeInteractionRecorder.recordBridgeStep(
                "sync.send.skipped",
                mapOf("realtimeSyncEnabled" to realtimeSyncEnabled, "isAttachedDocument" to (syncDocument === document))
            )
            return
        }
        val snapshot = ApplicationManager.getApplication().runReadAction<String?> {
            buildIdeSyncMessage(editor, document)
        }
        if (snapshot == null) {
            BridgeInteractionRecorder.recordBridgeStep("sync.send.skipped", mapOf("reason" to "snapshotUnavailable"))
            return
        }
        val syncKey = snapshot.hashCode().toString()
        if (syncKey == lastSyncKey) {
            BridgeInteractionRecorder.recordBridgeStep("sync.send.skipped", mapOf("reason" to "unchangedSnapshot"))
            return
        }
        lastSyncKey = syncKey
        val sent = client.sendDocumentSnapshot(snapshot)
        BridgeInteractionRecorder.recordBridgeStep("sync.send.snapshot", mapOf("sent" to sent, "snapshotChars" to snapshot.length))
    }

    private fun buildIdeSyncMessage(editor: Editor, document: Document): String? {
        val file = FileDocumentManager.getInstance().getFile(document) ?: return null
        if (!file.isInLocalFileSystem) return null
        val fullText = document.text
        val text = if (fullText.length > IDE_SYNC_TEXT_LIMIT) fullText.substring(0, IDE_SYNC_TEXT_LIMIT) else fullText
        val selectionModel = editor.selectionModel
        val json = listOf(
            "\"kind\":\"ide-sync-v1\"",
            "\"source\":\"jetbrains\"",
            "\"marker\":${jsonString(IDE_SYNC_MARKER)}",
            "\"uri\":${jsonString(file.url)}",
            "\"fsPath\":${jsonString(file.path)}",
            "\"languageId\":${jsonString(file.extension ?: "")}",
            "\"lineCount\":${document.lineCount}",
            "\"selectionStart\":${selectionModel.selectionStart}",
            "\"selectionEnd\":${selectionModel.selectionEnd}",
            "\"caretOffset\":${editor.caretModel.offset}",
            "\"text\":${jsonString(text)}",
            "\"truncated\":${fullText.length > IDE_SYNC_TEXT_LIMIT}",
            "\"timestamp\":${jsonString(Instant.now().toString())}"
        ).joinToString(",")
        return "{$json}"
    }

    private fun jsonString(value: String): String = "\"${escapeJson(value)}\""

    private fun escapeJson(value: String): String {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n")
            .replace("\t", "\\t")
    }
}

data class PendingSelectionEdit(
    val document: Document,
    val startOffset: Int,
    val endOffset: Int,
    val originalText: String
)

class ConnectBridgeAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("connect.invoked", mapOf("hasProject" to (event.project != null)))
        val client = CaoGenBridgeState.client
        val project = event.project
        val editor = event.getData(CommonDataKeys.EDITOR)
        val selection = editor?.selectionModel?.selectedText ?: ""
        val cwd = project?.basePath ?: System.getProperty("user.dir")
        val title = "IDE: ${project?.name ?: "JetBrains"}"
        client.connect().thenAccept {
            BridgeInteractionRecorder.recordActionStep(
                "connect.established",
                mapOf("cwd" to cwd, "hasEditor" to (editor != null), "hasSelection" to selection.isNotBlank())
            )
            client.requestSessions()
            client.createSession(cwd, title, selection)
            CaoGenBridgeState.attachDocumentSync(editor)
        }.exceptionally { error ->
            BridgeInteractionRecorder.recordActionStep(
                "connect.failed",
                mapOf("error" to (error.message ?: error.javaClass.name))
            )
            Messages.showErrorDialog(
                project,
                "CaoGen bridge connection failed: ${error.message}",
                "CaoGen Bridge"
            )
            null
        }
    }
}

class ToggleRealtimeSyncAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("realtimeSync.toggle.invoked")
        val project = event.project
        val editor = event.getData(CommonDataKeys.EDITOR)
        if (CaoGenBridgeState.realtimeSyncEnabled) {
            CaoGenBridgeState.realtimeSyncEnabled = false
            CaoGenBridgeState.detachDocumentSync()
            BridgeInteractionRecorder.recordActionStep("realtimeSync.disabled")
            Messages.showInfoMessage(project, "CaoGen realtime sync disabled.", "CaoGen Bridge")
            return
        }
        if (editor == null) {
            BridgeInteractionRecorder.recordActionStep("realtimeSync.enable.skipped", mapOf("reason" to "missingEditor"))
            Messages.showWarningDialog(project, "Open a local file before enabling CaoGen realtime sync.", "CaoGen Bridge")
            return
        }
        CaoGenBridgeState.realtimeSyncEnabled = true
        CaoGenBridgeState.attachDocumentSync(editor)
        BridgeInteractionRecorder.recordActionStep("realtimeSync.enabled")
        Messages.showInfoMessage(project, "CaoGen realtime sync enabled for the active file.", "CaoGen Bridge")
    }
}

class SendSelectionAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("sendSelection.invoked")
        val project = event.project
        val selection = event.getData(CommonDataKeys.EDITOR)?.selectionModel?.selectedText ?: ""
        if (selection.isBlank()) {
            BridgeInteractionRecorder.recordActionStep("sendSelection.skipped", mapOf("reason" to "blankSelection"))
            Messages.showWarningDialog(project, "No selected text to send to CaoGen.", "CaoGen Bridge")
            return
        }
        val client = CaoGenBridgeState.client
        val sessionId = client.activeSessionId()
        if (sessionId == null) {
            BridgeInteractionRecorder.recordActionStep("sendSelection.skipped", mapOf("reason" to "missingSession"))
            Messages.showWarningDialog(project, "Create or connect a CaoGen session first.", "CaoGen Bridge")
            return
        }
        if (client.sendSelection(sessionId, selection)) {
            BridgeInteractionRecorder.recordActionStep(
                "sendSelection.sent",
                mapOf("sessionId" to sessionId, "selectedChars" to selection.length)
            )
            Messages.showInfoMessage(project, "Selection sent to CaoGen.", "CaoGen Bridge")
        }
    }
}

class ChatAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("chat.invoked")
        val project = event.project
        val text = Messages.showInputDialog(
            project,
            "Message to CaoGen",
            "CaoGen Bridge",
            Messages.getQuestionIcon()
        ) ?: run {
            BridgeInteractionRecorder.recordActionStep("chat.cancelled")
            return
        }
        if (CaoGenBridgeState.client.sendChatMessage(text)) {
            BridgeInteractionRecorder.recordActionStep("chat.sent", mapOf("chars" to text.length))
            Messages.showInfoMessage(project, "Message sent to CaoGen.", "CaoGen Bridge")
        } else {
            BridgeInteractionRecorder.recordActionStep("chat.skipped", mapOf("reason" to "sendFailed"))
            Messages.showWarningDialog(project, "Create or connect a CaoGen session before chatting.", "CaoGen Bridge")
        }
    }
}

class RequestSelectionEditAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("requestSelectionEdit.invoked")
        val project = event.project
        val editor = event.getData(CommonDataKeys.EDITOR)
        val selectionModel = editor?.selectionModel
        val selection = selectionModel?.selectedText ?: ""
        if (selection.isBlank()) {
            BridgeInteractionRecorder.recordActionStep("requestSelectionEdit.skipped", mapOf("reason" to "blankSelection"))
            Messages.showWarningDialog(project, "No selected text to edit with CaoGen.", "CaoGen Bridge")
            return
        }
        val instruction = Messages.showInputDialog(
            project,
            "CaoGen edit instruction",
            "CaoGen Bridge",
            Messages.getQuestionIcon(),
            "Refactor this selection and keep behavior unchanged.",
            null
        ) ?: run {
            BridgeInteractionRecorder.recordActionStep("requestSelectionEdit.cancelled")
            return
        }
        if (CaoGenBridgeState.client.requestSelectionEdit(selection, instruction)) {
            if (editor != null && selectionModel != null) {
                CaoGenBridgeState.pendingEdit = PendingSelectionEdit(
                    editor.document,
                    selectionModel.selectionStart,
                    selectionModel.selectionEnd,
                    selection
                )
                BridgeInteractionRecorder.recordActionStep(
                    "requestSelectionEdit.pendingCaptured",
                    mapOf("selectedChars" to selection.length)
                )
            }
            BridgeInteractionRecorder.recordActionStep(
                "requestSelectionEdit.sent",
                mapOf("selectedChars" to selection.length, "hasInstruction" to instruction.isNotBlank())
            )
            Messages.showInfoMessage(project, "Selection edit request sent to CaoGen.", "CaoGen Bridge")
        } else {
            BridgeInteractionRecorder.recordActionStep("requestSelectionEdit.skipped", mapOf("reason" to "sendFailed"))
            Messages.showWarningDialog(project, "Create a CaoGen session before requesting an edit.", "CaoGen Bridge")
        }
    }
}

class PreviewSelectionDiffAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("previewSelectionDiff.invoked")
        val project = event.project
        val edit = CaoGenBridgeState.pendingEdit
        val proposed = CaoGenBridgeState.client.lastAssistantText()?.let { extractReplacementCode(it) }
        if (edit == null || proposed.isNullOrBlank()) {
            BridgeInteractionRecorder.recordActionStep(
                "previewSelectionDiff.skipped",
                mapOf("hasPendingEdit" to (edit != null), "hasProposal" to !proposed.isNullOrBlank())
            )
            Messages.showWarningDialog(project, "No CaoGen edit proposal is ready yet.", "CaoGen Bridge")
            return
        }
        val factory = DiffContentFactory.getInstance()
        val request = SimpleDiffRequest(
            "CaoGen Selection Diff",
            factory.create(edit.originalText),
            factory.create(proposed),
            "Original Selection",
            "CaoGen Proposed"
        )
        DiffManager.getInstance().showDiff(project, request)
        BridgeInteractionRecorder.recordActionStep(
            "previewSelectionDiff.shown",
            mapOf("originalChars" to edit.originalText.length, "proposedChars" to proposed.length)
        )
    }
}

class ApplySelectionEditAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("applySelectionEdit.invoked")
        val project = event.project
        val edit = CaoGenBridgeState.pendingEdit
        val proposed = CaoGenBridgeState.client.lastAssistantText()?.let { extractReplacementCode(it) }
        if (edit == null || proposed.isNullOrBlank()) {
            BridgeInteractionRecorder.recordActionStep(
                "applySelectionEdit.skipped",
                mapOf("hasPendingEdit" to (edit != null), "hasProposal" to !proposed.isNullOrBlank())
            )
            Messages.showWarningDialog(project, "No CaoGen edit proposal is ready yet.", "CaoGen Bridge")
            return
        }
        WriteCommandAction.runWriteCommandAction(project, Runnable {
            val safeStart = edit.startOffset.coerceIn(0, edit.document.textLength)
            val safeEnd = edit.endOffset.coerceIn(safeStart, edit.document.textLength)
            edit.document.replaceString(safeStart, safeEnd, proposed)
        })
        CaoGenBridgeState.pendingEdit = null
        BridgeInteractionRecorder.recordActionStep(
            "applySelectionEdit.applied",
            mapOf("originalChars" to edit.originalText.length, "proposedChars" to proposed.length)
        )
        Messages.showInfoMessage(project, "CaoGen edit applied. Use the IDE undo command to revert.", "CaoGen Bridge")
    }
}

class ShowEventsAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("showEvents.invoked")
        val events = CaoGenBridgeState.client.events()
        val body = if (events.isEmpty()) "No session.event messages received yet." else events.takeLast(20).joinToString("\n\n")
        BridgeInteractionRecorder.recordActionStep("showEvents.shown", mapOf("eventCount" to events.size))
        Messages.showInfoMessage(event.project, body, "CaoGen Bridge Events")
    }
}

class OpenDesktopAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        BridgeInteractionRecorder.recordActionStep("openDesktop.invoked")
        val cwd = event.project?.basePath ?: System.getProperty("user.dir")
        BrowserUtil.browse("caogen://ide-bridge?cwd=${java.net.URLEncoder.encode(cwd, Charsets.UTF_8)}")
        BridgeInteractionRecorder.recordActionStep("openDesktop.opened", mapOf("cwd" to cwd))
    }
}

private fun extractReplacementCode(text: String): String {
    val trimmed = text.trim()
    val fenced = Regex("```(?:\\w+)?\\s*([\\s\\S]*?)```").find(trimmed)?.groupValues?.get(1)
    return (fenced ?: trimmed).trimEnd()
}
