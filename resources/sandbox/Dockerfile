# CaoGen strict sandbox image.
# 构建命令:
# docker build -t caogen-sandbox:latest resources/sandbox
FROM node:22-alpine

ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
ARG NPM_REGISTRY=https://registry.npmmirror.com

USER root

# 预装常用构建/检索工具。镜像源通过 ARG 可覆盖,避免把区域性配置写死。
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|https://dl-cdn.alpinelinux.org/alpine|$ALPINE_MIRROR|g" /etc/apk/repositories; \
    fi \
    && apk add --no-cache \
      bash \
      cargo \
      g++ \
      git \
      go \
      jq \
      make \
      openjdk17-jre-headless \
      python3 \
      py3-pip \
      ripgrep \
      rust \
      tini \
    && npm config set registry "$NPM_REGISTRY" \
    && mkdir -p /workspace \
    && chown -R node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/bin/sh"]
