# CaoGen Website Demo Video

This isolated Remotion project renders the M2-T5 30-second product demo. It is
not a dependency of the Electron application and must not be added to the root
`package.json`.

## Render

```bash
npm install
node scripts/sanitize-assets.cjs
npm run lint
npm run still
npm run render
npm run validate:video
```

The render is `out/caogen-website-demo.mp4` (1920x1080, H.264, approximately
30 seconds). The `out/` directory is intentionally ignored so the website
repository can choose how to publish the final asset.

## Timeline

- 00:00–00:06: Provider and encrypted Key storage
- 00:06–00:13: task execution in the workbench
- 00:13–00:20: same-provider Key failover
- 00:20–00:27: isolated worktree and Diff review
- 00:27–00:30: CaoGen and the Intel x64 v0.1.7 download entry

The screenshots come from deterministic Electron evidence runs. The provider
source screenshot contains a synthetic test Key label; `sanitize-assets.cjs`
redacts that text before it is used in the public render. No production
credential is required to render this video.
