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

# Docker named volumes（macOS bind mount 不支持 Linux SGID 位，导致 reconfigure 失败）
VOL_CONFIG="gitlab-config"
VOL_LOGS="gitlab-logs"
VOL_DATA="gitlab-data"

# ---- helpers ----
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# ---- pre-flight ----
if ! command -v docker &>/dev/null; then
  red "错误: 未找到 docker，请先安装 Docker。"
  exit 1
fi

# ---- ensure docker volumes exist ----
for vol in "$VOL_CONFIG" "$VOL_LOGS" "$VOL_DATA"; do
  if ! docker volume inspect "$vol" &>/dev/null; then
    echo ">>> 创建 Docker volume: $vol"
    docker volume create "$vol"
  fi
done

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

# ---- post-start: ensure SGID on repos dir (mitigate race with reconfigure) ----
# macOS virtiofs 不支持 SGID，但 Docker volume (ext4) 支持；容器内 reconfigure 前 chmod 即可
echo ">>> 等待 GitLab 初始化..."
sleep 5
docker exec "$CONTAINER_NAME" chmod 2770 /var/opt/gitlab/git-data/repositories 2>/dev/null || true

echo ""
green "GitLab 容器已创建并启动。"
dim "首次启动需要 3-10 分钟初始化，等待出现 'gitlab Reconfigured!' 即就绪。"
echo ""
dim "监控日志:   docker logs -f $CONTAINER_NAME"
dim "获取 root 密码: docker exec -it $CONTAINER_NAME grep 'Password:' /etc/gitlab/initial_root_password"
dim "访问地址:   http://localhost:${HOST_HTTP}"
