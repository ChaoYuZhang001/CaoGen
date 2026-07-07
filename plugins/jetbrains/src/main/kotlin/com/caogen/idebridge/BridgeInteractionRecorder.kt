package com.caogen.idebridge

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.util.TreeMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

object BridgeInteractionRecorder {
    private const val ENABLED_PROPERTY = "caogen.jetbrains.recorder.enabled"
    private const val ENABLED_ENV = "CAOGEN_JETBRAINS_RECORDER_ENABLED"
    private const val PATH_PROPERTY = "caogen.jetbrains.recorder.path"
    private const val PATH_ENV = "CAOGEN_JETBRAINS_RECORDER_PATH"

    private val sequence = AtomicLong(0)
    private val bridgeCounters = ConcurrentHashMap<String, AtomicLong>()
    private val actionCounters = ConcurrentHashMap<String, AtomicLong>()
    private val lock = Any()

    private val enabled: Boolean by lazy {
        truthy(System.getProperty(ENABLED_PROPERTY)) || truthy(System.getenv(ENABLED_ENV))
    }

    private val outputPath: Path by lazy {
        val configured = System.getProperty(PATH_PROPERTY)?.takeIf { it.isNotBlank() }
            ?: System.getenv(PATH_ENV)?.takeIf { it.isNotBlank() }
        if (configured != null) {
            Path.of(configured)
        } else {
            Path.of(
                System.getProperty("java.io.tmpdir"),
                "caogen-jetbrains-recorder-${System.currentTimeMillis()}.jsonl"
            )
        }
    }

    fun recordBridgeStep(step: String, fields: Map<String, Any?> = emptyMap()) {
        record("bridge", step, fields)
    }

    fun recordActionStep(step: String, fields: Map<String, Any?> = emptyMap()) {
        record("action", step, fields)
    }

    private fun record(category: String, step: String, fields: Map<String, Any?>) {
        if (!enabled) return
        try {
            val counters = if (category == "action") actionCounters else bridgeCounters
            counters.computeIfAbsent(step) { AtomicLong(0) }.incrementAndGet()
            val line = buildJsonLine(category, step, fields)
            synchronized(lock) {
                outputPath.parent?.let { Files.createDirectories(it) }
                Files.writeString(
                    outputPath,
                    line + "\n",
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND
                )
            }
        } catch (_: Throwable) {
        }
    }

    private fun buildJsonLine(category: String, step: String, fields: Map<String, Any?>): String {
        val parts = mutableListOf(
            "\"timestamp\":${jsonString(Instant.now().toString())}",
            "\"sequence\":${sequence.incrementAndGet()}",
            "\"category\":${jsonString(category)}",
            "\"step\":${jsonString(step)}",
            "\"bridgeCounters\":${countersJson(bridgeCounters)}",
            "\"actionCounters\":${countersJson(actionCounters)}"
        )
        if (fields.isNotEmpty()) {
            parts.add("\"fields\":${mapJson(fields)}")
        }
        return "{${parts.joinToString(",")}}"
    }

    private fun countersJson(counters: ConcurrentHashMap<String, AtomicLong>): String {
        val sorted = TreeMap<String, Long>()
        counters.forEach { (key, value) -> sorted[key] = value.get() }
        return mapJson(sorted)
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
