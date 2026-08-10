# CaoGen v0.1.8 Windows Candidate

> Status: signing candidate. Publish as a GitHub prerelease only after SignPath returns
> a valid timestamped Authenticode signature for the exact public source commit. The
> current local preview is unsigned and is not a formal release asset. v0.1.7 remains
> the latest public release. Do not publish yet; no new release assets uploaded yet.

## Release Decision

This candidate packages the current CaoGen desktop development line for Windows x64.
It is intended for early user evaluation after the signed artifact, checksum, and
provenance record pass the release workflow. It does not claim completion of the full
CaoGen 1.0 acceptance matrix.

## Highlights

- Searchable Provider preset catalog with protocol, category, authorization, billing,
  and advanced request configuration surfaces.
- Provider key authorization flows, balance and usage views, pricing configuration,
  multiple encrypted credentials, routing, failover, health history, and profile sync.
- Explicit one-token generation probe for OpenAI Responses, OpenAI-compatible Chat
  Completions, Anthropic Messages, and Gemini-compatible endpoints.
- CC Switch configuration and usage import paths, including advanced Provider fields.
- Project workbench capabilities for files, language intelligence, diagnostics,
  testing, debugging, and refactoring without requiring IDE plugins.
- Chat ergonomics improvements, attachments, model/provider routing visibility,
  recovery paths, and desktop GUI operation controls.
- Assisted NSIS installation with custom install directory support, preserved user
  data, cancel-safe uninstall, and verified install-root cleanup.

## Uploaded Assets

No assets have been uploaded yet. The SignPath workflow will produce exactly these
candidate files before GitHub Releases publication:

- `CaoGen-0.1.8-windows-x64-setup.exe`
- `SHA256SUMS.txt`
- `PROVENANCE.json`

The exact SHA-256 values and source commit will be inserted from the successful signed
workflow artifact. Local `latest*.yml` files and unsigned previews are not uploadable
release assets.

## Truth Boundary

- This candidate targets Windows x64 only. macOS and Linux are outside this release.
- Provider availability depends on real keys, account permissions, quotas, endpoint
  compatibility, model access, and network conditions. A successful connectivity check
  is not a substitute for the real generation probe.
- Pricing and balance values are Provider-supplied or user-configured operational data;
  CaoGen does not guarantee external billing accuracy.
- The app can perform approved local workspace and desktop operations. It does not claim
  universal replacement of every IDE feature or every external agent product.
- Windows signing covers the distributed NSIS installer. SmartScreen reputation is
  separate from signature validity and may take time to accumulate for a new publisher.

## Known Blockers

- SignPath Foundation approval and the repository's five SignPath settings are not yet
  available, so the formal Authenticode artifact cannot be generated today.
- The exact candidate source must be committed and publicly available before dispatch.
- Final checksum, provenance, signed clean-install smoke, and GitHub prerelease evidence
  must be generated from the same commit before publication.

## Security Statement

The repository and release assets must not include real keys, private Provider URLs,
webhooks, certificates, signing keys, filled environment files, user projects,
`test-results`, `out`, `dist`, or `node_modules`. SignPath retains the signing key; GitHub
stores only the connector token and organization identifier needed by the workflow.

## macOS First Open

Not applicable to this Windows-only candidate. No macOS asset will be uploaded with the
Windows v0.1.8 prerelease.

## Verification

- Local unsigned preview: `CaoGen-0.1.8-windows-x64-unsigned-preview.exe`.
- Exact local source commit:
  `08e523cd1db0825087a5aa37df202e2caf273ea5`.
- Exact local preview size: `230076094` bytes.
- Exact local preview SHA-256:
  `332db2f7fca0184f686b4a19c52e8c708f32bce981ae533d1d203bb242334fa7`.
- Windows preview audit: `45/45` checks passed with a clean worktree, matching
  embedded provenance, x64 architecture, packaged runtime checks, and explicit
  unsigned status.
- The local digest identifies development evidence only and must not be reused for the
  signed installer, whose bytes and SHA-256 will differ.
- Final verification requires a clean exact-commit build, valid timestamped
  Authenticode status, standard SHA-256 manifest, provenance match, and packaged-app
  smoke on the signed installer.
