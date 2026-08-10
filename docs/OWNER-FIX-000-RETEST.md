# FIX-000 Owner Retest - Windows D0

> Date: 2026-08-08 (Asia/Shanghai)  
> Evidence owner: Product Owner  
> Environment: clean disposable Windows x64 with an interactive desktop  
> Result policy: this is dirty D0 defect verification, not C1 or release acceptance

## Exact Artifact

- File: `CaoGen-0.1.8-windows-x64-unsigned-preview.exe`
- Size: 229,172,133 bytes
- SHA-256: `938bc5c13ead77cb4dc592cbfa66ad3a4e93c44dbca7758c48f820815d4619c2`
- Artifact-set SHA-256: `898e778c976e1f2552854b244b4197b2b5d68123785718bf967acd4d0722bb13`
- Signature: intentionally unsigned preview
- Provenance: `main@374793c486261c90e91190d68ec81d3f8389d631`, `worktreeClean=false`
- Repository artifact: `dist/CaoGen-0.1.8-windows-x64-unsigned-preview.exe`

Preferred non-development handoff:

- Kit: `test-results/fix-000-owner-kit/2026-08-08T16-35-06-494Z-15672/CaoGen-FIX-000-Owner-Kit.zip`
- Kit size: 262,412,957 bytes
- Kit SHA-256: `d8486f5751a4e2d1f62fd486ef06e72bf2ee1ecc81165383e3d6d017ee5cf284`
- Kit manifest SHA-256: `7fdcf56c40bb7dbeea214edf7219467d24e6350419e844c525bfed10ac821eb3`
- Kit content-set SHA-256: `0445ee1cfbab283bf18fa12e9e26e5caee7372a5f37eba75914baa6953fcad6d`

The Product Owner should use [`OWNER-FIX-000-PORTABLE-KIT.md`](OWNER-FIX-000-PORTABLE-KIT.md). The kit carries the exact D0, a Windows x64 Node runtime and license, fail-fast clean-host preflight, installed-renderer smoke, result template, and manifest. The Owner host does not need a source checkout, Git, npm, or developer commands.

Before opening the installer, verify its size and digest in PowerShell:

```powershell
$Artifact = Get-Item -LiteralPath '<path-to-downloaded-exe>'
$Digest = Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact.FullName
$Artifact.Length
$Digest.Hash.ToLowerInvariant()
```

Stop if either value differs. Do not substitute another 0.1.8 installer with the same display name.

Before the manual flow, the Owner must first run the kit's installed-package smoke and path-bound assisted-install entry. Both must report `status=passed`. A failed preflight does not authorize an install attempt. A failure after installation preserves the diagnostic state and stops the flow. The previous D0 revision passed installed smoke, but its manual run stopped because a separately launched installer was not bound to the directory that passed preflight; those records are historical defect evidence and do not satisfy this SHA. This kit includes `RUN-FIX-000-ASSISTED-INSTALL.cmd`, so preflight, the sole final `/D` argument and post-install registry verification share one invocation. The exact SHA above has now passed the required private portable audit, path-bound assisted install and complete 12-step Owner flow; the Owner record SHA-256 is `511e689723246bf507dd9db2dbf22e92a43152ac1c85a61f802480cbef552914`.

## Preconditions

- Use a disposable Windows x64 VM or host snapshot with no CaoGen process, install directory, or CaoGen uninstall-registry entry.
- Confirm the desktop is interactive and the Owner can handle SmartScreen/UAC. Do not run this installer unattended on a personal machine.
- Prepare a disposable local Git project and record its initial `git status --short` privately.
- Keep real API keys, Provider URLs, project names/paths, Office output paths, notifications, and personal information out of public screenshots and this report.
- Save screenshots and private timing notes in an access-controlled evidence directory. The public report records only redacted outcomes and digests.

## 60-Minute Flow

| Step | Owner action | Pass condition | Evidence |
|---:|---|---|---|
| 0 | Verify EXE size/SHA and confirm no existing CaoGen install | Exact values above; clean preflight | Redacted preflight result |
| 1 | Run the kit's path-bound assisted-install entry for a disposable custom directory | Install completes once; result proves file/registry binding; no old-uninstaller error | Private assisted-install result, installer finish screenshot and elapsed time |
| 2 | Launch from the installed EXE | Usable welcome/first-task workspace; no persistent black renderer | First usable screen and time to interactive |
| 3 | Open Settings and add/edit one real OpenAI-compatible or Anthropic Provider | Save succeeds; key never reappears in plaintext | Redacted settings screenshot; agent checks `enc:` storage |
| 4 | Open the disposable local project | Project loads and persists | Redacted project-loaded screenshot; agent checks project record |
| 5 | Run a read-only task such as summarizing root files and README | Useful answer; no project mutation | Task screenshot plus before/after `git status --short` |
| 6 | Recruit one DigitalWorker in Studio | Recruitment completes and identity persists | Studio screenshot |
| 7 | Observe a real task status | Displayed worker/run state matches the actual task | Status screenshot and redacted task outcome |
| 8 | Generate one Word, Excel, or PowerPoint artifact | File exists, is non-empty, and opens | Artifact screenshot plus private path and SHA-256 |
| 9 | Close CaoGen fully and relaunch | Project/session/language recover; workspace remains usable | Restart screenshot and time to interactive |
| 10 | Start `Uninstall CaoGen.exe`; choose the default **No** | Exactly one explicit confirmation; uninstall cancels; app remains launchable | Confirmation screenshot and relaunch result |
| 11 | Start the uninstaller again; choose **Yes** | Install directory and uninstall registration disappear without partial deletion | Confirmation result and read-only residual scan |

## Backend Checks

After the Owner completes the corresponding UI step, the agent may perform read-only checks only:

- Provider: `providers.json` changed as expected and persistent tokens use the `enc:` envelope. Never print or decode credential values.
- Project/read-only task: project record exists; compare private Git status before/after and report only whether it changed.
- Restart: inspect `active-sessions.json`, backups, event receipts and relevant logs without exposing private values.
- Office: verify file existence, non-zero size and SHA-256; do not publish its path or content.
- Uninstall cancel: installed EXE still exists and launches; uninstall registry entry remains.
- Uninstall confirm: installed application directory and uninstall registry entry are absent. Any updater residue is recorded separately.
- Roaming CaoGen user data is expected to remain because `deleteAppDataOnUninstall=false` and the confirmation states that user data is preserved. Its presence is not an uninstall-cleanliness failure; unexpected deletion is a data-loss candidate.

## Stop Rules

- Stop immediately on data loss, credential disclosure, permission escape, unrecoverable partial deletion, or duplicate external side effects. Classify as Critical candidate.
- Stop the flow on any install/start/Provider/first-task blocker with no recovery path. Classify as High and return to `FIX-000`.
- Do not repair, reinstall, delete residuals, or retry destructive steps until the failed state has been captured with read-only evidence.
- Do not close S1, S2, or STOP-1 from unpacked diagnostics, source tests, or a different installer SHA.

## Result Record

Use [`OWNER-FIX-000-RESULT.template.json`](OWNER-FIX-000-RESULT.template.json) only as a schema template. Copy it to the private evidence directory outside the repository before filling it in; the audit deliberately rejects the repository template and every result record stored inside the repository. Keep an evidence path empty only when its matching step is `not_run`. Every executed step requires one distinct, non-empty private evidence file, and every failed step requires a finding.

For a stopped or failed run, preserve the failure without turning it green:

```powershell
npm run test:fix-000-owner-retest -- --record '<private-evidence-dir>\owner-fix-000-result.json'
```

A structurally valid failed run reports `status=observed_failed`; it does not satisfy the Sprint gate. For a complete 12-step pass, run the required audit:

```powershell
npm run test:fix-000-portable-smoke-audit:required -- --record '<private-evidence-dir>\fix-000-portable-smoke-result.json'
npm run test:fix-000-owner-retest:required -- --record '<private-evidence-dir>\owner-fix-000-result.json'
npm run test:sprint-01-gates
```

Both required private-result audits must report `status=passed` and exit 0. They emit only record/evidence digests and non-sensitive status summaries; they do not publish any private path or finding text. The Owner result must set `environment.portableSmokePassed=true` and bind the SHA-256 of the same private `fix-000-portable-smoke-result.json`; the Sprint audit compares this value with the portable smoke audit's `recordSha256`. It independently binds both results to the exact D0 digests above and keeps installed smoke and the 12-step Owner result as separate hard gates.

Record `passed`, `failed`, or `not_run` for every step. Each failure must include severity, shortest reproduction, expected/actual, impact, and redacted evidence reference. A complete pass on this dirty D0 permits preparation of a clean commit and `PKG-001`; it does not itself pass C1 or release gates.

## Historical Installed Continuation Observation - 2026-08-05

This section records a mixed manual/UI plus read-only backend observation from an earlier D0. It is retained as defect-discovery evidence only; it is not bound to the exact artifact above, is not a completed private result record, and does not satisfy either required audit.

- Artifact boundary: the handoff recorded the replacement installer SHA-256 as `28a6321488a41d7de18a129c0957e086478eea4db2427378193edc7f2df86abd`, but that file was unavailable for a final independent re-hash. The installed `CaoGen.exe` is version 0.1.8, 213,968,384 bytes, SHA-256 `e40477f316c79c41a9f9a41185ffb2ff735ee24a4a964dc09b86f4181ba76773`. The desktop installer with the same display filename still hashes to the older `d79534ac...` artifact.
- Step 2 passed as an installed observation: the Chinese workspace rendered and remained usable; the persistent black renderer did not recur.
- Step 3 passed for storage/redaction only: all persisted Provider credentials remained `enc:` values, and visible errors rendered Provider URLs as `[provider-url-redacted]`.
- Steps 4-5 passed: the project persisted; one slot-2 native Anthropic transcript completed `list_dir`, two `read_file` calls and `git_status` with `isError=false` in about 25.1 seconds. Source and isolated worktree Git status were empty, and the two controlled files retained identical SHA-256 values.
- Step 6 passed: one read-only DigitalWorker was recruited and persisted with workspace read enabled and workspace write, terminal and network disabled.
- Step 7 passed for state visibility: one WorkItem and one `active` assignment were persisted and shown as task/allocation count 1. This did not prove a successful Provider-backed worker run; the WorkItem remained `backlog`.
- Step 8 failed: a DOCX smoke task was submitted, the selected Provider returned 401, and no target artifact existed afterward.
- Step 9 passed: restart displayed the unfinished-task recovery UI, detected 58 recoverable tasks, and restored the DigitalWorker, active assignment and backlog WorkItem. `digital-workers.json` and `project-workspace.json` retained identical pre/post SHA-256 values; `backups/` and `event-receipts/` remained present. `active-sessions.json` was compacted during startup, so byte-for-byte equality is not claimed.
- Steps 10-11 were not run. Uninstall remains a separately confirmed destructive action.
- Private screenshot evidence: `05-06-08-worker-task-restart.jpg` SHA-256 `4600164267b7f498d7a43495a386b373a1478fdb0f5c7e7fae01961e46bfa216`; `07-office-provider-401-redacted.jpg` SHA-256 `f98d2ad8b3c1735ef79e18dafe40eccbcd1ddf168167bb6ef21f94b9e3426caa`. These files remain outside the repository because they contain private workspace context.

### S4 - High - Saved Provider/model preference is ignored by new sessions

- Repro: save slot 2 as the default Provider and save a concrete model; create a new session and submit a task.
- Expected: the new session uses the saved Provider/model unless the user explicitly selects global automatic routing.
- Actual: `settings.json` persisted slot 2 and the concrete model, but the new session was stored on another slot with `model=auto`; the OpenAI-compatible route attempted slots `3 -> 1 -> 4 -> 5` with three failovers. Slot 2 uses the Anthropic engine and was correctly excluded from the OpenAI failover set, but the explicit preference was still ignored. The Office smoke then failed with 401 and produced no artifact.
- Impact: Provider configuration appears successful but does not control execution. This blocks reliable first-task and Office delivery and keeps `FIX-000 / No-Go` open.
- Source-level lead: global re-selection occurs when `model=auto` and `routingScope=global` in `src/main/openaiEngine.ts`; the new-session creation chain also needs to apply `defaultProviderId/defaultModel` consistently.

Source FIX-000 evidence now closes the implementation gap but does not close the installed finding:

- `npm run test:provider-default-session-routing` passed with both renderer projection assertions and a real main-process `prepareSessionCreationDraft()` fixture. A concrete default model produces `fixed` on the saved Provider; `auto` produces `provider` on that same Provider.
- `npm run test:model-router`, `npm run test:model-failover`, `npm run test:first-task-onboarding`, `npm run test:anthropic-engine-registration`, `npm run typecheck`, and `npm run build` passed.
- The new D0 passed the Windows preview audit `40/40`. The installed replacement exited with code 0, launched the Chinese Provider editor without a black renderer, and preserved the existing user data. All ten persisted credential envelopes remained `enc:`; the default Provider remained slot 2 with a concrete model. Private launch screenshot SHA-256: `e7b22eaa1603a295cb82368fe158af4469d2a0e81ea3c5e6571b6b2f88227ef7`.

## Prior D0 Installed Continuation Evidence - 2026-08-05

- The prior D0 installer with SHA-256 `593b91eaca02381a5006e6dae49fe2ad499ba4626126d42468df66e609038e7a` completed a replacement install with exit code 0 while preserving user data. The installed `CaoGen.exe` was version 0.1.8, 213,968,384 bytes, SHA-256 `38acc48809786e96d3a2445348e5b598b17844bba21769d7266ab020f03863d6`. This evidence does not satisfy the exact artifact above.
- Eight key state-file digests were unchanged across replacement. Five Provider records, three project records, one DigitalWorker, one assignment, and 62 sessions remained present; all 10 persisted credential values retained the `enc:` envelope.
- Relaunch rendered a non-black Chinese workspace and unfinished-task recovery UI. The private off-screen screenshot remains outside the repository because it contains workspace context; its SHA-256 is `7a7cdf0af6fc6856d16e06c635b14aaadb426a178046c88c0e5e50f504509983`.
- The S4 implementation fix is present in the current D0 and its source gates pass, but S4 remains open until the exact current installed SHA completes a real first task using the saved default Provider/model with `routingScope=fixed` and no project mutation.
- The S5 Office repair was observed on the prior D0. Startup reconciliation confirmed the prior effect and added a `legacy-derived` Artifact with `projectRevision=0`, delivery Evidence, a `verifies` link, and passed Acceptance. The generated DOCX is 8,593 bytes with SHA-256 `7bbfe7d9defc86504e35cd6447087429a7748906ef3c6b647e2c6425936b5688`; required OOXML parts are structurally valid. No Word or LibreOffice renderer was available, so page-level visual verification remains unperformed. This remains historical evidence until the current D0 is installed.

Next required action: run the exact current packaged smoke, then reinstall the same SHA for the remaining Owner audit. Step 11 has a passing confirmation/result observation, but step 10 was skipped because the Owner selected **Yes** on the first prompt. A strict 12-step pass therefore still requires a fresh install, a cancel run that chooses **No** and proves relaunch, followed by a second confirmed uninstall. Do not enter `PKG-001` from source, replacement-install, launch, first-task, or partial uninstall evidence alone.

## Current D0 Replacement Attempt - 2026-08-06

- The exact current installer was started in silent replacement mode with the planned install directory as the final `/D` argument. It did not complete within 120 seconds and displayed `Failed to uninstall old application files. Please try running the installer again.: 2`.
- The old CaoGen processes had already exited and the persisted active-session record was `idle`. A read-only exclusive-lock scan found only `resources/app.asar` locked; Windows Restart Manager attributed that lock to a running WorkBuddy background process.
- The installer exited after the error was acknowledged. The previous CaoGen executable and uninstaller remained intact, the current D0 executable was not installed, all eight checked user-state file digests remained unchanged, and no user-data deletion was observed.
- Evidence: `test-results/fix-000-replacement-install/2026-08-06T00-46-40Z/report.json`. This is a failed replacement observation, not an installed smoke pass. Retrying requires the Owner to close WorkBuddy or explicitly authorize stopping it; CaoGen does not own that process.

## Current D0 Installed First-Task Result - 2026-08-06

- After the external WorkBuddy lock cleared, the exact D0 installed successfully with exit code 0. The installed executable SHA-256 is `e02013702d1bc778b9314c51ea8b098c371ab2e1c3dedbfeb44251ab5160b6b6`, matching the unpacked executable bound to the installer SHA above.
- The real read-only first task used the saved concrete Provider/model with `routingScope=fixed` and the Anthropic engine. Its transcript contains `list_dir`, two `read_file` calls, three successful tool results, and a `turn-result` with `subtype=success` and `isError=false`; the persisted session ended `idle`.
- The source project had zero Git user entries. The isolated worktree had one `.caogen` audit log entry and zero user entries; this is CaoGen runtime metadata, not a project mutation. All 10 credential envelopes remained encrypted.
- Evidence: `test-results/fix-000-first-task/2026-08-06T-installed/success-summary.json` and `fix-000-installed-first-task-reconciliation.json`. This closes the exact-SHA first-task routing/read-only finding, but does not satisfy installed smoke or the 12-step Owner required audit.

## Current D0 Confirmed Uninstall Result - 2026-08-06

- The Owner selected **Yes** on the uninstaller confirmation. The application install directory disappeared, the CaoGen uninstall registration count became zero, and no CaoGen process remained.
- Roaming user data remained as required by `deleteAppDataOnUninstall=false`: `providers.json` parses successfully with five Providers, five API-key records, and 10/10 `enc:` credential envelopes. The backup and event-receipt directories also remain populated.
- The updater cache retains one copy of the exact D0 installer, SHA-256 `8da0d31fe2de689dd321a5f72da292a830e7386246cd78015d80c33a0b1b7a44`. A desktop copy of the installer also remains. These are recorded residuals, not installed application files or app shortcuts.
- Evidence: `test-results/fix-000-uninstall/2026-08-06T13-09-47+08-00/report.json`. Step 11 passes on observed postconditions; step 10 remains `not_run`, so the complete Owner audit remains open.

## Current D0 Packaged Smoke and Assisted Install - 2026-08-06

- The isolated packaged smoke passed with the exact D0 installer: unsigned installer/app, non-empty preload-ready renderer, silent uninstall, install-root removal, registry removal, and isolated user-data preservation all passed. The private smoke record SHA-256 is `8e72cb6bc7b35840cd342b1b58a5280ee42502ce834cc7c32a6374f51de68840`.
- The path-bound assisted installer then passed against `D:\app\CaoGen`. It verified the app executable, direct uninstaller, and both uninstall registry commands were bound to the planned directory. The installed executable SHA-256 is `e02013702d1bc778b9314c51ea8b098c371ab2e1c3dedbfeb44251ab5160b6b6`.
- Private evidence is outside the repository. The assisted-install result SHA-256 is `120747e8739228f400567d39c6be139f21ecf10960b337d057c0f57ba3eb95c7`. The current install is intentionally preserved for the Owner flow.

## Current D0 Uninstall-Cancel and Relaunch Result - 2026-08-06

- The Owner selected **No** in the uninstaller confirmation. Read-only checks found the install directory, uninstaller, and CaoGen uninstall registration still present; the exact installed executable SHA remained `e02013702d1bc778b9314c51ea8b098c371ab2e1c3dedbfeb44251ab5160b6b6`.
- The same executable was relaunched for the postcondition check. A responsive `CaoGen` main window appeared, and the preserved user-data summary remained 5 Providers, 5 API-key records, and 10/10 `enc:` credential envelopes.
- Evidence: `test-results/fix-000-owner-step10/2026-08-06T13-41-41+08-00/report.json`. This is an observed pass for the cancel/relaunch postconditions; the final confirmed uninstall still remains to be executed.

## Current D0 Final Confirmed Uninstall Result - 2026-08-06

- The Owner selected **Yes**. CaoGen processes and uninstall registration are gone, and the application files were removed. The Roaming user-data directory remains intact with five Providers, five API-key records, 10/10 `enc:` envelopes, backups, and event receipts.
- The planned install directory itself remains as an empty directory. This fails the required clean-removal postcondition even though no executable or registration remains.
- Evidence: `test-results/fix-000-owner-step11/2026-08-06T13-44-42+08-00/report.json`. The empty-directory residual is recorded as `Low`; the Owner audit remains failed and must return to `FIX-000` for an installer/uninstaller cleanup fix before `PKG-001`.

## Current FIX-000 Cleanup Retest - 2026-08-06

- After the NSIS cleanup sequencing fix, the Owner-confirmed **Yes** uninstall was rechecked without manual deletion. The exact install root, executable, and direct uninstaller were absent; the CaoGen uninstall registration count and process count were both zero.
- The preserved Roaming user data still parsed with five Providers, five API-key records, and 10/10 `enc:` credential envelopes. Backup and event-receipt data remained present.
- Redacted observation: `test-results/fix-000-uninstall/2026-08-06T21-23-39+08-00/report.json`. The historical empty-directory failure remains unchanged above.

## Subsequent Owner Regression And Replacement D0 - 2026-08-07

- A later full Owner attempt against superseded installer SHA-256 `19062d9a3a8fe03c2e4cac5a9200b72541f8f2e264ad58b95d14eabb8e1e1155` passed the default-No cancel and relaunch branch. The final confirmed-Yes uninstall removed application files and registration and left zero CaoGen processes, but the exact install root remained as an empty directory after an additional 45-second read-only wait. No manual deletion was used.
- Preserved Roaming data still contained five Providers, five API-key records, and 10/10 `enc:` envelopes with zero plaintext credentials. This run fails the clean-removal condition regardless of the other postconditions.
- The helper had waited for the original uninstaller file path to disappear, but `un.atomicRMDir` removes that path before the process exits. It also used `timeout.exe`, which is not a reliable delay in a detached noninteractive process. The replacement helper binds the current uninstaller PID, waits for that PID to disappear, uses one 30-second retry budget, and uses `ping.exe` for an stdin-independent delay.
- Replacement D0 SHA-256 `a66a2ffd49d3f5985b132c4e77182957fe57414da291435f620add61964ff717` passes the 45/45 preview audit and exact unpacked TypeScript language-runtime smoke (8/8). It contains the Provider authentication-header fix, restored in-process NSIS install-root removal, and bundled TypeScript/JavaScript completion, hover, definition, and semantic diagnostics. Its complete portable installed smoke and 12-step Owner record remain required; prior D0 evidence is historical and does not transfer to this SHA.

- That D0 later reproduced a restart-only High blocker on retained historical data: five quarantined `recovering` TaskRuns without replay Snapshots caused `workflow_recovery_verification_failed` and prevented every new session. The current replacement D0 `8ba354a3...d9457` keeps executing/planning Runs fail-closed, but treats `recovering` and `waiting_reconciliation` Runs without Snapshots as non-replayable compatibility records. It preserves their unresolved Effects and allows unrelated new sessions. The canonical migration regression passes, the Windows preview audit passes 45/45, and the exact packaged TypeScript language runtime passes 8/8. Installed real-data and full Owner evidence remain required for this SHA.

The final current-SHA Owner run passed the required private portable audit, path-bound assisted install, installed model discovery returning six models without 401, a successful fixed-route read-only task with zero Git user-entry change, Studio recruitment and persistence, one successful Office artifact with exactly one `create_document` side effect, durable restart recovery, a one-prompt default-No cancel/relaunch, and confirmed uninstall. The exact install root disappeared in 0.293 seconds; registration and process counts were zero; user data remained at 5 Providers, 5 API-key records, 10/10 encrypted credential envelopes, and 5 DigitalWorkers. The required audit passed 12/12 with zero Critical, High, Medium, or Low findings; record SHA-256 `511e689723246bf507dd9db2dbf22e92a43152ac1c85a61f802480cbef552914`.

## Superseded D0 Uninstall Failure - 2026-08-07

- Installer SHA-256 `a7a7270f8714974e4dc10c3c0f9a7de6079d314044acdd9787ad7d29e8aa9e05` passed installation and the installed Provider 401 retest, but failed the confirmed-uninstall gate.
- The Owner cancel run showed one confirmation with No focused by default; cancellation preserved the EXE, uninstaller, registration, and a usable relaunch.
- On the confirmed run, the registry and CaoGen processes disappeared, but the installation root still contained 142 empty directories after 45 seconds. No residual was manually removed.
- Root cause: the custom `customRemoveFiles` path called `un.atomicRMDir`, which moves files for rollback but leaves the directory tree, while omitting electron-builder's default in-process `RMDir /r $INSTDIR`. The helper did not remove that empty tree before its bounded retry window expired.
