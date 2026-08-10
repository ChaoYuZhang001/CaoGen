# FIX-000 Owner Portable Retest Kit

> Scope: exact dirty D0 defect verification on a clean disposable Windows x64 host  
> Owner entry: installed EXE only; no source checkout, Git, npm, or system automation is required  
> Stop rule: any failed installed smoke, Critical candidate, or High blocker stops the flow

## 1. Verify the Kit

The kit manifest and the handoff message provide the ZIP SHA-256. Verify the downloaded ZIP before extraction. After extraction, keep every file together and do not replace the installer with another file carrying the same version name.

The exact installer inside this kit must have:

- Size: `229172133` bytes
- SHA-256: `938bc5c13ead77cb4dc592cbfa66ad3a4e93c44dbca7758c48f820815d4619c2`
- Artifact-set SHA-256: `898e778c976e1f2552854b244b4197b2b5d68123785718bf967acd4d0722bb13`

Use a disposable Windows x64 VM or revertible host snapshot. Do not use a personal machine or a host that already has CaoGen installed.

## 2. Prepare Private Evidence

Create a private evidence directory outside both the extracted kit and the planned CaoGen install directory. It must not be synchronized to a public repository or shared channel. Screenshots must not expose API keys, Provider URLs, project paths, Office output paths, notifications, or personal information.

Copy `OWNER-FIX-000-RESULT.template.json` into that private directory. Keep the template in the kit unchanged. After the installed smoke passes, record the SHA-256 of `fix-000-portable-smoke-result.json` in `environment.portableSmokeRecordSha256` and set `environment.portableSmokePassed` to `true`.

## 3. Run the Installed-Package Smoke

Open Command Prompt in the extracted kit directory and run:

```bat
RUN-FIX-000-PACKAGED-SMOKE.cmd "<private-evidence-directory>"
```

The runner defaults to No. It starts only after the Owner types the exact confirmation `RUN-FIX-000`. The Owner must handle SmartScreen and UAC directly; the smoke does not click, dismiss, bypass, or automate Windows security prompts.

This smoke performs a clean-host check, silently installs D0 into a random disposable directory, launches the installed EXE with isolated user data, checks a non-empty preload-ready renderer, saves a private screenshot, silently uninstalls, verifies the install directory and uninstall registration are gone, verifies user data was preserved, and then removes only its own temporary test root.

Pass condition: `fix-000-portable-smoke-result.json` reports `status: "passed"`. On any failure it exits non-zero, preserves an installed diagnostic state when one exists, and records its private location only in the private report. Stop immediately. Do not rerun, uninstall, repair, or delete the failed state before read-only inspection.

After a pass, compute the private record digest and enter it in the copied Owner result template:

```bat
certutil -hashfile "<private-evidence-directory>\fix-000-portable-smoke-result.json" SHA256
```

Set `environment.portableSmokePassed` to `true` and `environment.portableSmokeRecordSha256` to the 64-character digest. Do not add the evidence directory path to any public report.

## 4. Run the Path-Bound Assisted Installer

Choose a new disposable custom install directory that does not exist. Run the path-bound entry below; do not start the installer separately:

```bat
RUN-FIX-000-ASSISTED-INSTALL.cmd "<private-evidence-directory>" "<new-disposable-install-directory>"
```

This entry performs the same clean-host preflight and then passes the exact planned directory to the interactive NSIS installer as its final `/D` argument. The Owner still handles SmartScreen, UAC, installer choices, and Finish directly. It does not silently install, launch CaoGen, uninstall, or clean the resulting installation. After the installer exits, it verifies internally that the application files, direct uninstaller, and both uninstall registry commands are all bound to the planned directory; paths remain only in the private result.

Pass condition: `fix-000-assisted-install-result.json` reports `status: "passed"` and `installation.plannedInstallDirBound: true`. On failure, stop and preserve the installation exactly as found. `RUN-FIX-000-PREFLIGHT.cmd` remains available for diagnosis only; a standalone preflight followed by a separately launched installer is not sufficient evidence for step 1.

## 5. Execute the 60-Minute Owner Flow

| Step | Owner action | Pass condition |
|---:|---|---|
| 0 | Verify the exact D0 and start the path-bound assisted-install entry | Size/digests match; no process, install registration, or target directory exists |
| 1 | Complete the interactive installer launched by that entry | Result proves files and uninstall registration are bound to the preflighted directory; no old-uninstaller error |
| 2 | Launch the installed EXE | Usable welcome/first-task workspace; no persistent black renderer |
| 3 | Add or edit one real OpenAI-compatible or Anthropic Provider | Save succeeds; key never reappears in plaintext |
| 4 | Open a disposable local Git project | Project loads and persists |
| 5 | Run a read-only root-file/README summary | Useful result; before/after `git status --short` is unchanged |
| 6 | Recruit one DigitalWorker in Studio | Recruitment completes and persists |
| 7 | Observe one real task status | Displayed status matches the task outcome |
| 8 | Generate one Word, Excel, or PowerPoint artifact | File exists, is non-empty, opens, and has a private SHA-256 |
| 9 | Fully close and relaunch CaoGen | Project/session/language recover; workspace stays usable |
| 10 | Start the direct uninstaller and choose default **No** | Exactly one confirmation; cancel leaves CaoGen launchable |
| 11 | Start the direct uninstaller again and choose **Yes** | Install directory and uninstall registration disappear; user data remains |

Save one distinct private evidence file for every executed step. Leave the corresponding template path empty only for a `not_run` step. Every failed step requires a finding with severity, reproduction, expected, actual, impact, and evidence role.

## 6. Return Evidence Privately

Return these items only through the agreed private channel:

- `fix-000-portable-smoke-result.json`
- `fix-000-packaged-smoke-renderer.png`
- `fix-000-portable-smoke-preflight.json`
- `fix-000-assisted-install-result.json`
- completed `owner-fix-000-result.json`
- the 12 referenced Owner evidence files

Do not include API keys, Provider URLs, project paths, Office paths, or personal data in a public issue, commit, chat, or report. A dirty D0 pass permits preparation of `PKG-001`; it is not C1 or release acceptance.
