---
name: WeChat Mini Program Delivery
description: Prepare, verify, and hand off WeChat Mini Program tasks with local checks and optional real-network credential validation.
trigger: wechat miniprogram 小程序 微信小程序 wxapp
tags: [china, wechat, miniprogram, skill]
version: 1.0.0
---

## Real Network Env

- Preferred: `WECHAT_MINIPROGRAM_API_URL`, `WECHAT_MINIPROGRAM_TOKEN`, optional `WECHAT_MINIPROGRAM_METHOD`, `WECHAT_MINIPROGRAM_BODY`, `WECHAT_MINIPROGRAM_AUTH_PREFIX`.
- Backward compatible: `WECHAT_MINIPROGRAM_CHECK_URL`.
- The real-network smoke reports `wechat_miniprogram_api`; do not treat a skipped result as verified.

# WeChat Mini Program Delivery

用于微信小程序开发任务的交付检查。默认使用本地项目命令；真实微信平台接口验证必须由用户显式提供检查端点或凭据。

## Steps

1. 识别项目类型：原生小程序、uni-app、Taro、mpx 或其他框架。
2. 检查 `project.config.json`、`app.json`、页面路由、分包、权限声明和环境配置。
3. 优先运行项目内已有的 typecheck、lint、build 或小程序构建命令。
4. 若需要真实平台验证，提供 `WECHAT_MINIPROGRAM_CHECK_URL` 或等价的企业内网检查端点，并运行 `CAOGEN_CHINA_REAL_NETWORK=1 npm.cmd run test:china-real-network`。
5. 输出构建日志、检查端点状态、脱敏 appid 和剩余人工上传/审核步骤。

## Verification

1. `npm.cmd run typecheck`
2. 项目内小程序构建命令，例如 `npm.cmd run build:weapp`
3. `CAOGEN_CHINA_REAL_NETWORK=1 npm.cmd run test:china-real-network`
