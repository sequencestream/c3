# Docker GitLab Compose

## 前置条件

- Docker + Docker Compose 已安装
- 机器内存 ≥ 4GB（GitLab 推荐 8GB+）

## 目录结构

```
~/gitlab-compose/
├── docker-compose.yml
└── volumes/          # 持久化数据（自动创建）
```

## Compose 文件

在 `~/gitlab-compose/docker-compose.yml`:

```yaml
services:
  gitlab:
    image: gitlab/gitlab-ee:latest
    container_name: gitlab
    restart: unless-stopped
    hostname: gitlab.local
    environment:
      GITLAB_OMNIBUS_CONFIG: |
        external_url 'http://gitlab.local:8929'
        gitlab_rails['gitlab_shell_ssh_port'] = 2424
    ports:
      - "8929:8929"   # HTTP
      - "2424:22"     # SSH
    volumes:
      - ./volumes/config:/etc/gitlab
      - ./volumes/logs:/var/log/gitlab
      - ./volumes/data:/var/opt/gitlab
    shm_size: '256m'
```

> **镜像选择**: `gitlab/gitlab-ee` 企业版、`gitlab/gitlab-ce` 社区版；固定版本用 tag，如 `gitlab/gitlab-ce:17.3.0-ce.0`。

## 启动

```bash
cd ~/gitlab-compose

# 前台启动（查看日志）
docker compose up

# 后台启动
docker compose up -d
```

首次启动会拉取镜像并初始化数据库，耗时 **3-10 分钟**。等待 `docker compose logs -f` 出现 `gitlab Reconfigured!` 或访问 `http://localhost:8929` 返回登录页即为就绪。

初次登录：
- 用户名: `root`
- 密码: 从容器内获取 → `docker exec -it gitlab grep 'Password:' /etc/gitlab/initial_root_password`

## 停止 / 重启

```bash
# 停止（保留数据）
docker compose stop

# 停止并删除容器（保留 volumes 数据）
docker compose down

# 停止并删除容器 + 所有数据（不可逆）
docker compose down -v
```

```bash
# 重启
docker compose restart

# 仅重读 gitlab.rb 配置（不重启容器）
docker exec -it gitlab gitlab-ctl reconfigure
```

## 常用运维

```bash
# 查看日志
docker compose logs -f                # 所有
docker compose logs -f gitlab         # 指定服务

# 进入容器
docker exec -it gitlab bash

# GitLab 组件状态
docker exec -it gitlab gitlab-ctl status

# 备份
docker exec -it gitlab gitlab-backup create
# 备份文件在 ~/gitlab-compose/volumes/data/backups/

# 恢复（指定备份时间戳）
docker exec -it gitlab gitlab-backup restore BACKUP=<timestamp>
```

## 端口说明

| 主机端口 | 容器用途   | 说明               |
| -------- | ---------- | ------------------ |
| 8929     | HTTP       | Web 访问 + API     |
| 2424     | SSH        | `git clone git@...` |

访问地址: `http://localhost:8929`

## 资源限制 (可选)

```yaml
services:
  gitlab:
    # ...
    deploy:
      resources:
        limits:
          memory: 6g
```
