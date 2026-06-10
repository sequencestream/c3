#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="$HOME/gitlab-compose"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
GITLAB_URL="http://localhost:8929"

# ---- helpers ----
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# ---- pre-flight ----
if ! command -v docker &>/dev/null; then
  red "错误: 未找到 docker，请先安装 Docker。"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  red "错误: docker compose 不可用，请升级 Docker 或安装 Compose 插件。"
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  red "错误: 未找到 $COMPOSE_FILE"
  red "请先在 $COMPOSE_DIR 下创建 docker-compose.yml。"
  exit 1
fi

# ---- check if already running ----
cd "$COMPOSE_DIR"

RUNNING=$(docker compose ps --status running -q 2>/dev/null || true)
if [[ -n "$RUNNING" ]]; then
  green "GitLab 已在运行中。"
  dim "访问地址: $GITLAB_URL"
  exit 0
fi

# ---- start ----
echo "启动 GitLab (docker compose up -d) ..."
docker compose up -d

echo ""
green "GitLab 容器已启动。"
dim "首次启动需要 3-10 分钟初始化数据库，等待出现 'gitlab Reconfigured!' 即就绪。"
echo ""
dim "监控日志:   docker compose -f $COMPOSE_FILE logs -f"
dim "检查状态:   docker compose -f $COMPOSE_FILE ps"
dim "获取 root 密码: docker exec -it gitlab grep 'Password:' /etc/gitlab/initial_root_password"
dim "访问地址:   $GITLAB_URL"
