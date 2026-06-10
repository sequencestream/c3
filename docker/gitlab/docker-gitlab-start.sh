#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------
# docker-gitlab-start.sh — 使用 docker run 启动 GitLab
# --------------------------------------------------

CONTAINER_NAME="gitlab"
IMAGE="gitlab/gitlab-ce:latest"

HOST_HTTP="8929"
HOST_SSH="2424"
HOSTNAME="gitlab.local"

# 卷目录（宿主机路径）
VOL_CONFIG="${HOME}/gitlab-compose/volumes/config"
VOL_LOGS="${HOME}/gitlab-compose/volumes/logs"
VOL_DATA="${HOME}/gitlab-compose/volumes/data"

# ---- helpers ----
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# ---- pre-flight ----
if ! command -v docker &>/dev/null; then
  red "错误: 未找到 docker，请先安装 Docker。"
  exit 1
fi

# ---- ensure volume dirs ----
mkdir -p "$VOL_CONFIG" "$VOL_LOGS" "$VOL_DATA"

# ---- pull image if missing ----
if ! docker image inspect "$IMAGE" &>/dev/null; then
  echo ">>> 拉取镜像: $IMAGE"
  docker pull "$IMAGE"
fi

# ---- container already exists → start or report ----
if docker ps -a --format '{{.Names}}' | grep -qxF "$CONTAINER_NAME"; then
  STATE=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME")
  case "$STATE" in
    running)
      green "GitLab 已在运行中。"
      dim "访问地址: http://localhost:${HOST_HTTP}"
      exit 0
      ;;
    paused)
      echo ">>> 恢复暂停的容器: $CONTAINER_NAME"
      docker unpause "$CONTAINER_NAME"
      ;;
    *)
      echo ">>> 启动已有容器: $CONTAINER_NAME"
      docker start "$CONTAINER_NAME"
      ;;
  esac
  green "GitLab 容器已启动。"
  dim "监控日志: docker logs -f $CONTAINER_NAME"
  dim "访问地址: http://localhost:${HOST_HTTP}"
  exit 0
fi

# ---- first run: create + start ----
echo ">>> 创建并启动 GitLab 容器..."

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --hostname "$HOSTNAME" \
  --shm-size 256m \
  -p "${HOST_HTTP}:8929" \
  -p "${HOST_SSH}:22" \
  -v "${VOL_CONFIG}:/etc/gitlab" \
  -v "${VOL_LOGS}:/var/log/gitlab" \
  -v "${VOL_DATA}:/var/opt/gitlab" \
  -e GITLAB_OMNIBUS_CONFIG="external_url 'http://${HOSTNAME}:${HOST_HTTP}'; gitlab_rails['gitlab_shell_ssh_port']=${HOST_SSH};" \
  "$IMAGE"

echo ""
green "GitLab 容器已创建并启动。"
dim "首次启动需要 3-10 分钟初始化，等待出现 'gitlab Reconfigured!' 即就绪。"
echo ""
dim "监控日志:   docker logs -f $CONTAINER_NAME"
dim "获取 root 密码: docker exec -it $CONTAINER_NAME grep 'Password:' /etc/gitlab/initial_root_password"
dim "访问地址:   http://localhost:${HOST_HTTP}"
