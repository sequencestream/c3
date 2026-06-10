#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="$HOME/gitlab-compose"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"

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

if [[ ! -f "$COMPOSE_FILE" ]]; then
  red "错误: 未找到 $COMPOSE_FILE"
  exit 1
fi

cd "$COMPOSE_DIR"

# ---- check if running ----
RUNNING=$(docker compose ps --status running -q 2>/dev/null || true)
if [[ -z "$RUNNING" ]]; then
  yellow "GitLab 未在运行（没有 running 容器）。"
  exit 0
fi

# ---- stop ----
echo "停止 GitLab ..."

if [[ "${1:-}" == "--down" ]]; then
  # 停止并删除容器（保留 volumes 数据）
  docker compose down
  green "GitLab 容器已停止并删除（数据卷保留）。"
else
  # 仅停止容器（保留容器 + 数据）
  docker compose stop
  green "GitLab 已停止。"
  dim ""
  dim "重新启动:     $0 的同级 docker-gitlab-start.sh"
  dim "停止并删容器: $0 --down"
  dim "删除全部数据: docker compose -f $COMPOSE_FILE down -v  (不可逆!)"
fi
