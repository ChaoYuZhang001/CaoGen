package com.caogen.idebridge

import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.Duration
import java.util.concurrent.CompletionStage
import java.util.concurrent.CopyOnWriteArrayList

data class BridgeSettings(
    val url: String = "ws://127.0.0.1:17365/ide-bridge",
    val token: String = ""
)

class CaoGenBridgeClient(private val settings: BridgeSettings = BridgeSettings()) : WebSocket.Listener {
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    private var socket: WebSocket? = null
    @Volatile
    private var activeSessionId: String? = null
    @Volatile
    private var lastAssistantText: String? = null
    private val eventLog = CopyOnWriteArrayList<String>()
    private val sessionReadyListeners = CopyOnWriteArrayList<() -> Unit>()

    fun connect(): CompletionStage<WebSocket> {
        BridgeInteractionRecorder.recordBridgeStep("connect.start", mapOf("url" to settings.url))
        return httpClient.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .buildAsync(URI.create(settings.url), this)
            .whenComplete { _, error ->
                if (error != null) {
                    BridgeInteractionRecorder.recordBridgeStep(
                        "connect.error",
                        mapOf("error" to (error.message ?: error.javaClass.name))
                    )
                }
            }
            .thenApply { connected ->
                socket = connected
                BridgeInteractionRecorder.recordBridgeStep("connect.connected")
                connected.sendText(helloMessage(), true)
                BridgeInteractionRecorder.recordBridgeStep("send.hello", mapOf("hasToken" to settings.token.isNotBlank()))
                connected
            }
    }

    fun requestSessions(): Boolean {
        val current = socket ?: return bridgeUnavailable("sessions.list")
        current.sendText("""{"id":"jb-list","type":"sessions.list"}""", true)
        BridgeInteractionRecorder.recordBridgeStep("send.sessions.list")
        return true
    }

    fun createSession(cwd: String, title: String, selectedText: String): Boolean {
        val current = socket ?: return bridgeUnavailable("sessions.create")
        val initialText = if (selectedText.isBlank()) {
            ""
        } else {
            ",\"initialText\":\"来自 JetBrains 选区:\\n\\n${escapeJson(selectedText)}\""
        }
        current.sendText(
            """{"id":"jb-create","type":"sessions.create","payload":{"cwd":"${escapeJson(cwd)}","title":"${escapeJson(title)}"$initialText}}""",
            true
        )
        BridgeInteractionRecorder.recordBridgeStep(
            "send.sessions.create",
            mapOf("cwd" to cwd, "title" to title, "hasSelection" to selectedText.isNotBlank())
        )
        return true
    }

    fun activeSessionId(): String? = activeSessionId

    fun sendSelection(sessionId: String, selectedText: String): Boolean {
        val current = socket ?: return bridgeUnavailable("sessions.send.selection")
        if (selectedText.isBlank()) {
            BridgeInteractionRecorder.recordBridgeStep("skip.sessions.send.selection.blank")
            return false
        }
        current.sendText(
            """{"id":"jb-send","type":"sessions.send","payload":{"sessionId":"${escapeJson(sessionId)}","message":{"text":"来自 JetBrains 选区:\n\n${escapeJson(selectedText)}"}}}""",
            true
        )
        BridgeInteractionRecorder.recordBridgeStep(
            "send.sessions.send.selection",
            mapOf("sessionId" to sessionId, "selectedChars" to selectedText.length)
        )
        return true
    }

    fun sendToActiveSession(text: String): Boolean {
        val sessionId = activeSessionId ?: return false
        return sendSelection(sessionId, text)
    }

    fun sendChatMessage(text: String): Boolean {
        val current = socket ?: return bridgeUnavailable("sessions.send.chat")
        val sessionId = activeSessionId ?: return missingSession("sessions.send.chat")
        if (text.isBlank()) {
            BridgeInteractionRecorder.recordBridgeStep("skip.sessions.send.chat.blank")
            return false
        }
        current.sendText(
            """{"id":"jb-chat","type":"sessions.send","payload":{"sessionId":"${escapeJson(sessionId)}","message":{"text":"${escapeJson(text)}"}}}""",
            true
        )
        BridgeInteractionRecorder.recordBridgeStep(
            "send.sessions.send.chat",
            mapOf("sessionId" to sessionId, "chars" to text.length)
        )
        return true
    }

    fun sendDocumentSnapshot(snapshotJson: String): Boolean {
        val current = socket ?: return bridgeUnavailable("documents.sync")
        val sessionId = activeSessionId ?: return missingSession("documents.sync")
        if (snapshotJson.isBlank()) {
            BridgeInteractionRecorder.recordBridgeStep("skip.documents.sync.blank")
            return false
        }
        val id = "jb-doc-sync-${System.currentTimeMillis()}"
        current.sendText(
            """{"id":"$id","type":"documents.sync","payload":{"sessionId":"${escapeJson(sessionId)}","snapshot":$snapshotJson}}""",
            true
        )
        BridgeInteractionRecorder.recordBridgeStep(
            "send.documents.sync",
            mapOf("sessionId" to sessionId, "requestId" to id, "snapshotChars" to snapshotJson.length)
        )
        return true
    }

    fun requestSelectionEdit(selectedText: String, instruction: String): Boolean {
        val current = socket ?: return bridgeUnavailable("sessions.send.edit")
        val sessionId = activeSessionId ?: return missingSession("sessions.send.edit")
        if (selectedText.isBlank()) {
            BridgeInteractionRecorder.recordBridgeStep("skip.sessions.send.edit.blank")
            return false
        }
        val prompt = listOf(
            "来自 JetBrains 选区的修改请求。",
            "请只返回完整替换后的选区代码；如无法安全修改，请说明原因。",
            "",
            "修改要求: ${instruction.ifBlank { "保持行为不变并改进质量" }}",
            "",
            "```",
            selectedText,
            "```"
        ).joinToString("\n")
        current.sendText(
            """{"id":"jb-edit","type":"sessions.send","payload":{"sessionId":"${escapeJson(sessionId)}","message":{"text":"${escapeJson(prompt)}"}}}""",
            true
        )
        BridgeInteractionRecorder.recordBridgeStep(
            "send.sessions.send.edit",
            mapOf(
                "sessionId" to sessionId,
                "selectedChars" to selectedText.length,
                "hasInstruction" to instruction.isNotBlank()
            )
        )
        return true
    }

    fun events(): List<String> = eventLog.toList()

    fun lastAssistantText(): String? = lastAssistantText

    fun addSessionReadyListener(listener: () -> Unit) {
        sessionReadyListeners.add(listener)
    }

    override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
        val text = data.toString()
        BridgeInteractionRecorder.recordBridgeStep(
            "receive.text",
            mapOf("chars" to text.length, "last" to last)
        )
        captureCreatedSessionId(text)
        if (text.contains(""""type":"session.event"""")) {
            eventLog.add(text)
            BridgeInteractionRecorder.recordBridgeStep("receive.session.event", mapOf("chars" to text.length))
            extractPayloadText(text)?.let { lastAssistantText = it }
        }
        webSocket.request(1)
        return null
    }

    override fun onOpen(webSocket: WebSocket) {
        BridgeInteractionRecorder.recordBridgeStep("websocket.open")
        webSocket.request(1)
    }

    private fun helloMessage(): String {
        val tokenField = if (settings.token.isBlank()) "" else ",\"token\":\"${escapeJson(settings.token)}\""
        return """{"id":"jb-hello","type":"hello","payload":{"protocol":1,"client":"jetbrains","role":"jetbrains"$tokenField}}"""
    }

    private fun escapeJson(value: String): String {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n")
            .replace("\t", "\\t")
    }

    private fun captureCreatedSessionId(text: String) {
        if (!text.contains(""""type":"sessions.create.result"""")) return
        val match = Regex("\"payload\"\\s*:\\s*\\{[^}]*\"id\"\\s*:\\s*\"([^\"]+)\"").find(text)
        if (match != null) {
            val nextSessionId = match.groupValues[1]
            val changed = activeSessionId != nextSessionId
            activeSessionId = nextSessionId
            BridgeInteractionRecorder.recordBridgeStep(
                "session.active.captured",
                mapOf("sessionId" to nextSessionId, "changed" to changed)
            )
            if (changed) {
                for (listener in sessionReadyListeners) listener()
            }
        }
    }

    private fun extractPayloadText(text: String): String? {
        val match = Regex("\"text\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"").find(text) ?: return null
        return unescapeJson(match.groupValues[1])
    }

    private fun unescapeJson(value: String): String {
        val out = StringBuilder()
        var index = 0
        while (index < value.length) {
            val ch = value[index]
            if (ch != '\\' || index + 1 >= value.length) {
                out.append(ch)
                index += 1
                continue
            }
            val escaped = value[index + 1]
            when (escaped) {
                '"' -> out.append('"')
                '\\' -> out.append('\\')
                '/' -> out.append('/')
                'b' -> out.append('\b')
                'f' -> out.append('\u000C')
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'u' -> {
                    val hex = value.substring(index + 2, minOf(index + 6, value.length))
                    val code = hex.toIntOrNull(16)
                    if (hex.length == 4 && code != null) {
                        out.append(code.toChar())
                        index += 4
                    } else {
                        out.append("\\u")
                    }
                }
                else -> out.append(escaped)
            }
            index += 2
        }
        return out.toString()
    }

    private fun bridgeUnavailable(operation: String): Boolean {
        BridgeInteractionRecorder.recordBridgeStep("skip.$operation.socketUnavailable")
        return false
    }

    private fun missingSession(operation: String): Boolean {
        BridgeInteractionRecorder.recordBridgeStep("skip.$operation.missingSession")
        return false
    }
}
