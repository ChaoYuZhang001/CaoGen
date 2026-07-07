# P2 External Required Verification

This file documents the real external evidence needed to close P2 required gates.
Do not commit real secrets, webhook URLs, tokens, private repository names, or recordings that expose credentials.

## Quick Preflight

Run the non-network preflight first. It only checks local files and environment variable presence.

```powershell
npm.cmd run test:p2-external:preflight
```

Strict mode exits non-zero when any external gate is not ready:

```powershell
npm.cmd run test:p2-external:preflight -- --required
```

The report is written to `test-results/p2-external-preflight/latest.json`.

Generate an operator-facing doctor report after preflight. Use `--refresh` when you want the doctor to refresh strict preflight first:

```powershell
npm.cmd run test:p2-external:doctor -- --refresh
```

The doctor writes JSON and Markdown reports to:

- `test-results/p2-external-doctor/latest.json`
- `test-results/p2-external-doctor/latest.md`

Run the completion audit to separate locally proved P2 items from missing real external evidence:

```powershell
npm.cmd run test:p2-audit
```

Strict audit mode exits non-zero while any P2 requirement is not proved:

```powershell
npm.cmd run test:p2-audit -- --required
```

The audit report is written to `test-results/p2-completion-audit/latest.json`.

For staged China real-network verification, set the same target filter used by the required smoke before running preflight:

```powershell
$env:CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS = "feishu,dingtalk,wecom,gitee_issue"
npm.cmd run test:p2-external:preflight -- --required
```

Generate a handoff pack for a real external verification machine:

```powershell
npm.cmd run test:p2-external:pack
```

The pack is written to `test-results/p2-external-pack/<runId>/` and contains:

- `.env.template`
- `china-parity-providers.template.json`
- `jetbrains-evidence.template.json`
- `run-required-gates.ps1`

The generated runner can load a private env file without printing secret values:

```powershell
.\test-results\p2-external-pack\<runId>\run-required-gates.ps1 -EnvFile D:\private\p2.external.env
```

Validate the local external gate validators themselves:

```powershell
npm.cmd run test:p2-external:validators
```

This smoke intentionally covers both positive and negative cases. It accepts BOM-prefixed provider/evidence JSON, and rejects weak JetBrains session evidence, China provider parity without a baseline provider, and private or localhost real-network endpoints.

## China Real Network

Required command:

```powershell
$env:CAOGEN_CHINA_REAL_NETWORK = "1"
npm.cmd run test:china-real-network:required
```

Required target filter in required mode:

```powershell
$env:CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS = "feishu,dingtalk,wecom,gitee_issue"
```

Required configuration by target:

| Target | Required env | Optional env |
| --- | --- | --- |
| `feishu` | `FEISHU_WEBHOOK_URL` | `FEISHU_WEBHOOK_SECRET` |
| `dingtalk` | `DINGTALK_WEBHOOK_URL` | `DINGTALK_WEBHOOK_SECRET` |
| `wecom` | `WECOM_WEBHOOK_URL` | |
| `gitee_issue` | `GITEE_ACCESS_TOKEN`, `GITEE_OWNER`, `GITEE_REPO` | `GITEE_API_URL` |
| `gitee_pull_request` | `GITEE_ACCESS_TOKEN`, `GITEE_OWNER`, `GITEE_REPO`, `GITEE_PR_HEAD`, `GITEE_PR_BASE` | `GITEE_API_URL`, `GITEE_PR_DRAFT` |
| `aliyun_yunxiao_api` | `ALIYUN_YUNXIAO_API_URL` | `ALIYUN_YUNXIAO_TOKEN`, `ALIYUN_YUNXIAO_METHOD`, `ALIYUN_YUNXIAO_BODY`, `ALIYUN_YUNXIAO_AUTH_PREFIX` |
| `tencent_coding_api` | `TENCENT_CODING_API_URL` | `TENCENT_CODING_TOKEN`, `TENCENT_CODING_METHOD`, `TENCENT_CODING_BODY`, `TENCENT_CODING_AUTH_PREFIX` |
| `wechat_miniprogram_api` | `WECHAT_MINIPROGRAM_API_URL` | `WECHAT_MINIPROGRAM_TOKEN`, `WECHAT_MINIPROGRAM_METHOD`, `WECHAT_MINIPROGRAM_BODY`, `WECHAT_MINIPROGRAM_AUTH_PREFIX` |

Legacy aliases still supported:

- `ALIYUN_DEVOPS_CHECK_URL` can replace `ALIYUN_YUNXIAO_API_URL`.
- `ALIYUN_DEVOPS_TOKEN` can replace `ALIYUN_YUNXIAO_TOKEN`.
- `TENCENT_CODING_CHECK_URL` can replace `TENCENT_CODING_API_URL`.
- `WECHAT_MINIPROGRAM_CHECK_URL` can replace `WECHAT_MINIPROGRAM_API_URL`.

## China Tool-Call Parity

Required command:

```powershell
$env:CAOGEN_CHINA_TOOL_CALL_PARITY = "1"
$env:CAOGEN_CHINA_PARITY_PROVIDERS = '<providers-json>'
npm.cmd run test:china-tool-call-parity:required
```

`CAOGEN_CHINA_PARITY_PROVIDERS` may also point to a local JSON file when running the preflight, required parity gate, or generated external pack runner.
In required mode, each provider `baseUrl` must use a public HTTPS host. Localhost, private IP ranges, mock hosts, and placeholder domains are rejected before parity is accepted.

Provider JSON example:

```json
[
  {
    "id": "openai-baseline",
    "name": "OpenAI baseline",
    "group": "baseline",
    "apiFormat": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4.1-mini",
    "apiKey": "<secret>"
  },
  {
    "id": "deepseek-china",
    "name": "DeepSeek China",
    "group": "china",
    "apiFormat": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKey": "<secret>"
  }
]
```

Optional controls:

- `CAOGEN_CHINA_PARITY_REQUIRE_BASELINE=0`: allow running only China providers without a baseline.
- `CAOGEN_CHINA_PARITY_MAX_GAP=<number>`: allow China provider pass-rate gap from the best baseline.

## JetBrains Real IDE Interaction

Build verification is not enough for P2-005. The required gate must prove a real JetBrains IDE interaction.

Required command:

```powershell
$env:CAOGEN_JETBRAINS_IDE_PATH = "C:\Program Files\JetBrains\IntelliJ IDEA <version>\bin\idea64.exe"
$env:CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON = "D:\path\to\jetbrains-evidence.json"
npm.cmd run test:jetbrains-ide-interaction:required
```

Instead of manually filling `CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON`, the JetBrains plugin can emit an opt-in recorder JSONL file during a real IDE workflow:

```powershell
# Add these JVM properties to the JetBrains IDE test run.
-Dcaogen.jetbrains.recorder.enabled=true
-Dcaogen.jetbrains.recorder.path=D:\path\to\caogen-jetbrains-recorder.jsonl

# Then validate the recorder output from the CaoGen repo.
$env:CAOGEN_JETBRAINS_IDE_PATH = "C:\Program Files\JetBrains\IntelliJ IDEA <version>\bin\idea64.exe"
$env:CAOGEN_JETBRAINS_IDE_RECORDER_JSONL = "D:\path\to\caogen-jetbrains-recorder.jsonl"
$env:CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED = "1"
npm.cmd run test:jetbrains-ide-interaction:required
```

For local automated evidence generated by `npm.cmd run test:jetbrains-recorder-e2e:required`, the validator may reuse the latest passed recorder E2E report. In that mode the evidence source is reported as `latest-recorder-e2e-runIde`, and the proof is the Gradle `runIde` sandbox log plus recorder JSONL. This proves the sandboxed lifecycle autorun workflow only; it must not be described as a full manual workflow in an installed JetBrains 2026.1.4 IDE.

`CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED=1` must only be set after a human or GUI automation verifies that the applied edit is reversible through the IDE native undo command.

Required evidence JSON:

```json
{
  "ideName": "IntelliJ IDEA",
  "ideVersion": "<real IDE version>",
  "ideExecutable": "C:\\Program Files\\JetBrains\\IntelliJ IDEA <version>\\bin\\idea64.exe",
  "pluginVersion": "0.0.1",
  "pluginDistribution": "D:\\project\\CaoGen\\plugins\\jetbrains\\build\\distributions\\caogen-jetbrains-bridge-0.0.1.zip",
  "workspace": "D:\\project\\CaoGen",
  "steps": {
    "installedPlugin": true,
    "connectCreateSession": true,
    "sendChatMessage": true,
    "sendSelection": true,
    "requestSelectionEdit": true,
    "previewSelectionDiff": true,
    "applySelectionEdit": true,
    "nativeUndoVerified": true,
    "toggleRealtimeSync": true,
    "documentSyncObserved": true,
    "showEvents": true,
    "openDesktop": true
  },
  "bridgeEvents": {
    "helloCount": 1,
    "sessionCreateCount": 1,
    "sessionSendCount": 3,
    "chatSendCount": 1,
    "selectionSendCount": 1,
    "editRequestSendCount": 1,
    "documentSyncCount": 1
  },
  "actionCounts": {
    "diffPreviewCount": 1,
    "applyEditCount": 1,
    "nativeUndoCount": 1,
    "realtimeToggleCount": 1,
    "openDesktopCount": 1
  },
  "artifacts": [
    "D:\\path\\to\\jetbrains-ide-smoke.log",
    "D:\\path\\to\\screenshot.png"
  ]
}
```

If `CAOGEN_JETBRAINS_IDE_PATH` and both evidence inputs (`CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON` / `CAOGEN_JETBRAINS_IDE_RECORDER_JSONL`) are missing, `npm.cmd run test:jetbrains-ide-interaction:required` must fail with structured `missingConfiguration` and templates in `test-results/jetbrains-ide-interaction/latest.json`.

The external preflight validates the same evidence shape before the required gate, whether it comes from JSON or recorder JSONL: required steps must be `true`, bridge/action counters must be present, `sessionSendCount` must be at least `3`, `pluginVersion` must match the current JetBrains plugin build, `pluginDistribution` must point to the current plugin zip, the workspace path must exist, and at least one artifact path or URL must be supplied.
For manual JSON evidence or an explicit recorder file, the IDE executable path must exist and must point to a known JetBrains IDE binary name such as `idea64.exe`, `webstorm64.exe`, `pycharm64.exe`, `clion64.exe`, `goland64.exe`, `rider64.exe`, `datagrip64.exe`, `phpstorm64.exe`, or `rubymine64.exe`. For auto-discovered latest recorder E2E evidence, a valid `gradle-runIde` runtime log can satisfy the runtime identity check even when the IDE executable is not present as a standalone installation path.

## Aggregate Gate

Full P2 required gate:

```powershell
npm.cmd run test:p2-required
```

The aggregate gate writes completed evidence to:

- `test-results/p2-required/latest.json`
- `test-results/p2-required/latest-completed.json`
- `test-results/p2-required/<runId>/evidence/`

During a run, intermediate state is written to `test-results/p2-required/latest-running.json` so completed evidence is not overwritten by a partial run.
