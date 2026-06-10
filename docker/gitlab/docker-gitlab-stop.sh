#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------
# docker-gitlab-stop.sh — 停止 GitLab 容器
# --------------------------------------------------

CONTAINER_NAME="gitlab"

# ---- helpers ----
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# ---- pre-flight ----
if ! command -v docker &>/dev/null; then
  red "错误: 未找到 docker。"
  exit 1
fi

# ---- container exists? ----
if ! docker ps -a --format '{{.Names}}' | grep -qxF "$CONTAINER_NAME"; then
  yellow "容器 $CONTAINER_NAME 不存在，无需停止。"
  exit 0
fi

STATE=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME")

# ---- handle each state ----
case "$STATE" in
  running)
    echo ">>> 正在停止 $CONTAINER_NAME ..."
    docker stop "$CONTAINER_NAME"
    green "GitLab 已停止。"
    ;;
  paused)
    echo ">>> 容器处于 paused 状态，先恢复再停止..."
    docker unpause "$CONTAINER_NAME"
    docker stop "$CONTAINER_NAME"
    green "GitLab 已停止。"
    ;;
  exited|created)
    yellow "容器状态为 $STATE，无需停止。"
    ;;
  *)
    yellow "容器状态为 $STATE，跳过。"
    ;;
esac
