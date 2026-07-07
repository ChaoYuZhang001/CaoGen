---
name: Aliyun Yunxiao DevOps Handoff
description: Prepare and verify Aliyun Yunxiao or Codeup work item, pipeline, and merge-request handoff for a CaoGen task.
trigger: aliyun yunxiao codeup devops 云效 阿里云效
tags: [china, devops, aliyun, yunxiao, codeup]
version: 1.0.0
---

## Real Network Env

- Preferred: `ALIYUN_YUNXIAO_API_URL`, `ALIYUN_YUNXIAO_TOKEN`, optional `ALIYUN_YUNXIAO_METHOD`, `ALIYUN_YUNXIAO_BODY`, `ALIYUN_YUNXIAO_AUTH_PREFIX`.
- Backward compatible: `ALIYUN_DEVOPS_CHECK_URL`, `ALIYUN_DEVOPS_TOKEN`.
- The real-network smoke reports `aliyun_yunxiao_api`; do not treat a skipped result as verified.

# Aliyun Yunxiao DevOps Handoff

用于把 CaoGen 任务结果交接到阿里云效 / Codeup。默认只准备请求和验收证据；真实触网必须由用户显式提供云效端点和 token。

## Steps

1. 确认目标组织、项目、仓库、分支、工作项或流水线名称，避免把 Gitee/GitHub 字段直接套到云效。
2. 检查环境变量 `ALIYUN_DEVOPS_CHECK_URL`、`ALIYUN_DEVOPS_TOKEN`、`ALIYUN_DEVOPS_PROJECT` 是否由用户显式提供。
3. 若只做准备，生成工作项 / 合并请求 / 流水线触发所需字段清单，并标注 dry-run。
4. 若用户要求真实验收，运行 `CAOGEN_CHINA_REAL_NETWORK=1 npm.cmd run test:china-real-network`，确认云效端点返回 2xx/3xx。
5. 将返回的 request id、状态码、耗时和脱敏端点记录到任务结果，不记录 token。

## Verification

1. `npm.cmd run test:china-ecosystem`
2. `CAOGEN_CHINA_REAL_NETWORK=1 npm.cmd run test:china-real-network`
3. 检查输出中 `aliyun_yunxiao` 为 `pass`，否则保持未验收状态。
