---
name: Tencent CODING DevOps Handoff
description: Prepare and verify Tencent CODING DevOps work item, repository, pipeline, or merge-request handoff for a CaoGen task.
trigger: tencent coding devops 腾讯云 腾讯 CODING
tags: [china, devops, tencent, coding]
version: 1.0.0
---

## Real Network Env

- Preferred: `TENCENT_CODING_API_URL`, `TENCENT_CODING_TOKEN`, optional `TENCENT_CODING_METHOD`, `TENCENT_CODING_BODY`, `TENCENT_CODING_AUTH_PREFIX`.
- Backward compatible: `TENCENT_CODING_CHECK_URL`.
- The real-network smoke reports `tencent_coding_api`; do not treat a skipped result as verified.

# Tencent CODING DevOps Handoff

用于把 CaoGen 任务结果交接到腾讯 CODING DevOps。默认不触网；真实调用必须由用户显式提供 CODING 端点和 token。

## Steps

1. 确认团队、项目、仓库、目标分支、工作项或流水线名称。
2. 检查环境变量 `TENCENT_CODING_CHECK_URL`、`TENCENT_CODING_TOKEN`、`TENCENT_CODING_PROJECT` 是否存在。
3. dry-run 时只输出请求字段、目标链接、风险和需要用户确认的权限范围。
4. 真实验收时运行 `CAOGEN_CHINA_REAL_NETWORK=1 npm.cmd run test:china-real-network`，只接受 2xx/3xx 状态作为通过。
5. 记录脱敏 URL、状态码、耗时和时间戳，不保存 token。

## Verification

1. `npm.cmd run test:china-ecosystem`
2. `CAOGEN_CHINA_REAL_NETWORK=1 npm.cmd run test:china-real-network`
3. 检查输出中 `tencent_coding` 为 `pass`，否则保持未验收状态。
