package com.caogen.idebridge

import com.intellij.openapi.application.ApplicationManager
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

private const val E2E_ENABLED_ENV = "CAOGEN_JETBRAINS_RECORDER_E2E"
private const val E2E_EXIT_ENV = "CAOGEN_JETBRAINS_RECORDER_E2E_EXIT"
private const val E2E_WORKSPACE_ENV = "CAOGEN_JETBRAINS_WORKSPACE"
private const val E2E_MARKER_ENV = "CAOGEN_JETBRAINS_RECORDER_MARKER_PATH"

object RecorderE2EDiagnostics {
    private val autorunStarted = AtomicBoolean(false)

    fun enabled(): Boolean = truthy(System.getenv(E2E_ENABLED_ENV))

    fun shouldExit(): Boolean = truthy(System.getenv(E2E_EXIT_ENV))

    fun workspace(): String = System.getenv(E2E_WORKSPACE_ENV)?.takeIf { it.isNotBlank() }
        ?: System.getProperty("user.dir")

    fun tryBeginAutorun(step: String, fields: Map<String, Any?> = emptyMap()): Boolean {
        if (autorunStarted.compareAndSet(false, true)) {
            recordMarker(step, fields)
            return true
        }
        recordMarker("autorun.skipped.duplicate", mapOf("trigger" to step))
        return false
    }

    fun recordMarker(step: String, fields: Map<String, Any?> = emptyMap()) {
        val markerPath = System.getenv(E2E_MARKER_ENV)?.takeIf { it.isNotBlank() } ?: return
        try {
            val line = buildJsonLine(step, fields)
            val path = Path.of(markerPath)
            path.parent?.let { Files.createDirectories(it) }
            Files.writeString(
                path,
                line + "\n",
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE,
                StandardOpenOption.APPEND
            )
        } catch (_: Throwable) {
        }
    }

    fun exitIfRequested() {
        if (!shouldExit()) return
        ApplicationManager.getApplication().invokeLater {
            ApplicationManager.getApplication().exit(false, true, false)
        }
    }

    private fun buildJsonLine(step: String, fields: Map<String, Any?>): String {
        val parts = mutableListOf(
            "\"timestamp\":${jsonString(Instant.now().toString())}",
            "\"step\":${jsonString(step)}"
        )
        if (fields.isNotEmpty()) parts.add("\"fields\":${mapJson(fields)}")
        return "{${parts.joinToString(",")}}"
    }

    private fun mapJson(values: Map<String, Any?>): String {
        return values.entries.joinToString(",", prefix = "{", postfix = "}") { (key, value) ->
            "${jsonString(key)}:${valueJson(value)}"
        }
    }

    private fun valueJson(value: Any?): String {
        return when (value) {
            null -> "null"
            is Boolean -> value.toString()
            is Number -> value.toString()
            else -> jsonString(value.toString())
        }
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

    private fun truthy(value: String?): Boolean {
        return when (value?.trim()?.lowercase()) {
            "1", "true", "yes", "on", "enabled" -> true
            else -> false
        }
    }
}
