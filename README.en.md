<div align="center">

<p><a href="./README.md">简体中文</a> | <strong>English</strong></p>

<img src="./resources/icon.png" alt="CaoGen" width="96" height="96">

# CaoGen

## A multi-vendor AI work desktop. Bring your own keys, run the models you choose, and fail over by policy when a service becomes unavailable.

<img src="https://img.shields.io/badge/version-v0.1.6-blue" alt="version">
<img src="https://img.shields.io/badge/license-AGPL--3.0--only-green" alt="AGPL-3.0-only">
<img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20build-lightgrey" alt="platform">
<img src="https://img.shields.io/badge/Electron-40-informational" alt="Electron 40">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome">

[Download](https://github.com/ChaoYuZhang001/CaoGen/releases) · [Quick Start](#quick-start) · [Contribute](#contribute-to-caogen) · [Roadmap](#roadmap--long-term-vision-under-construction)

![CaoGen main workspace](./docs/screenshot-app.jpg)

</div>

## What is CaoGen?

CaoGen is an open-source, vendor-neutral, local-first AI work desktop that brings multi-provider models, your local projects, and the tools needed to complete work into one Electron app. You use your own API keys and treat providers as replaceable compute while project directories, worktrees, tools, and review stay in your desktop workflow.

It gives users one reviewable local workspace for multiple models, projects, files, tasks, and tools.

> “The models you choose” means models reachable through CaoGen's currently supported OpenAI-compatible, Anthropic Messages, or optional Agent SDK paths. Availability still depends on protocol compatibility, account access, network conditions, and quota.

| Capability | CaoGen today | Evidence boundary |
|---|---|---|
| Providers and models | Multiple providers, BYOK, and custom compatible services | Only configured, protocol-compatible targets are in scope |
| Failure recovery | Controlled failover across backup keys and configured providers | External accounts, networks, and quota can still block requests |
| Local workflow | Local projects, Git worktrees, Diff, terminal, and file tools | High-risk actions remain subject to permission and acceptance gates |
| Openness | AGPL-3.0-only with separate commercial licensing | Public installers are not yet formally signed or notarized |

This table describes the current product structure. It does not claim that every model, provider, or external network condition has been validated; see [STATUS.md](./STATUS.md) for exact boundaries.

## Core capabilities available today

- **Connect multiple providers with BYOK**: configure multiple providers and API keys, custom base URLs, gateways, or local OpenAI-compatible services for common compatible model sources such as DeepSeek, Kimi, and GLM.
- **Route work and fail over automatically**: choose targets by capability, cost, speed, budget, and health; for recoverable quota, rate-limit, server, or network failures, try a backup key first and then a configured healthy provider.
- **Isolate task changes**: create a dedicated Git worktree for a session, inspect diffs and conflicts before merging, export or apply patches, and discard the isolated workspace when needed.
- **Finish work inside one workbench**: use an integrated terminal, file browser, text editor, browser, Diff and Git tools, plus previews for HTML, Markdown, JSON, CSV, images, PDF, and Office documents.
- **Inspect a live 3D office**: visualize real session state including running, approval, completed, failed, provider, cost, subtask, and worktree/Git signals. The current release uses robot office assets; the ink-animation character direction remains roadmap work.

![CaoGen 3D office](./docs/screenshot-office.jpg)

## Quick Start

1. **Download**: choose an asset for your platform and architecture from [GitHub Releases](https://github.com/ChaoYuZhang001/CaoGen/releases). Public assets currently center on macOS x64 v0.1.6, Windows x64 v0.1.5, and an older macOS arm64 build; Linux currently means running from source or building locally.
2. **Add a provider and key**: open Settings, select a provider template or enter the base URL of a compatible service, then add your own API key. Keys are never committed to this repository.
3. **Run your first task**: create a session, select a local project directory or use an unassigned session, then try: `Read this project and tell me how it starts, which files matter most, and the three highest-value issues. Do not change anything yet.`

> Current public installers are not formally signed or notarized. macOS and Windows may show operating-system security warnings on first launch; download only from this repository's Releases and verify the corresponding release notes. Formal 1.0 acceptance and release readiness are tracked in [STATUS.md](./STATUS.md).

Run from source:

```bash
git clone https://github.com/ChaoYuZhang001/CaoGen.git
cd CaoGen
npm install
npm run dev
```

## Roadmap / Long-term vision (under construction)

CaoGen's long-term direction is a vendor-neutral Agent Work OS built around persistent Goals, WorkItems, digital workers, Artifacts/Evidence, acceptance, and recovery, alongside a richer 3D office experience. These are roadmap goals, not a claim about features available today; read the [active execution plan](./docs/PLAN.md), [Project Charter](./docs/PROJECT-CHARTER.md), [Product Requirements](./docs/PRODUCT-REQUIREMENTS.md), and [Current Status](./STATUS.md) for the intended scope and verified progress.

## Contribute to CaoGen

**We are looking for people who want to build reliable, vendor-neutral, local-first AI work infrastructure in the open.**

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, the six-link architecture path, and the pull request workflow.
- Start with the [good-first-issue drafts](./docs/good-first-issues.md) or the live GitHub [good first issues](https://github.com/ChaoYuZhang001/CaoGen/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22).
- Open a [bug report](https://github.com/ChaoYuZhang001/CaoGen/issues/new?template=bug_report.yml), [feature request](https://github.com/ChaoYuZhang001/CaoGen/issues/new?template=feature_request.yml), or pull request.

Report security issues privately through [SECURITY.md](./SECURITY.md). CaoGen is licensed under [AGPL-3.0-only](./LICENSE), with a separate [commercial license](./COMMERCIAL-LICENSE.md) available.
