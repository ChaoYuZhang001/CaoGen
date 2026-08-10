# CaoGen SignPath Open Source Setup

CaoGen uses SignPath Foundation for Windows Authenticode signing. The unsigned NSIS
installer is built from an exact public Git commit in GitHub Actions and is never
downloaded from or replaced by a developer workstation.

## Project facts

- Repository: `https://github.com/ChaoYuZhang001/CaoGen`
- License: `AGPL-3.0-only`
- Windows artifact: NSIS x64 installer (`.exe`)
- Build system: GitHub Actions on `windows-2025`
- Build command: `npx electron-builder --config electron-builder.windows-preview.cjs --win nsis --x64 --publish never`
- Signing workflow: `.github/workflows/windows-signpath-release.yml`
- SignPath action: pinned `SignPath/github-action-submit-signing-request` v2 commit
- Artifact configuration: `.signpath/artifact-configuration.xml`

## Foundation application

Apply at `https://signpath.org/apply` using the public repository above. The application
must identify GitHub-hosted runners as the trusted build system and the NSIS x64
installer as the signing artifact. Approval and certificate issuance are external
SignPath Foundation decisions; repository automation cannot create or bypass them.

After approval, create the SignPath project, upload
`.signpath/artifact-configuration.xml` as its artifact configuration, and restrict the
release signing policy origin to this repository. Permit the `main` branch and release
tags only. The XML intentionally signs the single NSIS installer contained in the ZIP
created by `actions/upload-artifact`.

## GitHub configuration

Configure these only after SignPath creates the organization and project:

| Kind | Name | Value |
|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | SignPath GitHub connector API token |
| Secret | `SIGNPATH_ORGANIZATION_ID` | SignPath organization ID |
| Variable | `SIGNPATH_PROJECT_SLUG` | CaoGen SignPath project slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | Approved release signing policy |
| Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Artifact configuration that signs the NSIS `.exe` |

The workflow takes an exact commit SHA, verifies the checkout, uploads the unsigned
installer through `actions/upload-artifact`, passes that immutable artifact ID to
SignPath, verifies `Get-AuthenticodeSignature` returns `Valid`, and uploads only the
verified signed result. It also requires a timestamp, produces a conventional
`SHA256SUMS.txt`, and records version, exact commit, digest, and public certificate
identity in `PROVENANCE.json` without exposing any secret value.

Run the local contract before pushing workflow changes:

```powershell
npm.cmd run test:windows-signpath-workflow-contract
```

Once all five GitHub settings exist, dispatch the workflow with the full 40-character
candidate commit. A short SHA, branch name, or tag is rejected.

## Trust boundary

- No certificate or private key is stored in this repository or in GitHub Secrets.
- SignPath owns the private signing key and applies the approved signing policy.
- Local unsigned preview files are never formal signed-release inputs.
- A GitHub Release must identify the exact source commit used by the signing workflow.
- The candidate workflow never creates or modifies a GitHub Release. Publication is a
  separate step after signed-artifact verification.
