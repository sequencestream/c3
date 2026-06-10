# Docker GitLab (docker run)

## 前置条件

- Docker 已安装
- 机器内存 ≥ 4GB（GitLab 推荐 8GB+）

## 目录结构

```
~/gitlab-compose/          # 仅保留 volumes 持久化数据
└── volumes/
    ├── config/            # /etc/gitlab
    ├── logs/              # /var/log/gitlab
    └── data/              # /var/opt/gitlab
```

## 启动

```bash
./docker/gitlab/docker-gitlab-start.sh
```

等效手动命令：

```bash
docker run -d \
  --name gitlab \
  --restart unless-stopped \
  --hostname gitlab.local \
  --shm-size 256m \
  -p 8929:8929 \
  -p 2424:22 \
  -v ~/gitlab-compose/volumes/config:/etc/gitlab \
  -v ~/gitlab-compose/volumes/logs:/var/log/gitlab \
  -v ~/gitlab-compose/volumes/data:/var/opt/gitlab \
  -e GITLAB_OMNIBUS_CONFIG="external_url 'http://gitlab.local:8929'; gitlab_rails['gitlab_shell_ssh_port']=2424;" \
  gitlab/gitlab-ce:latest
```

首次启动会拉取镜像并初始化数据库，耗时 **3-10 分钟**。等待 `docker logs -f gitlab` 出现 `gitlab Reconfigured!` 或访问 `http://localhost:8929` 返回登录页即为就绪。

初次登录：
- 用户名: `root`
- 密码: `docker exec -it gitlab grep 'Password:' /etc/gitlab/initial_root_password`

## 停止

```bash
./docker/gitlab/docker-gitlab-stop.sh
```

等效手动命令：

```bash
docker stop gitlab             # 停止（保留容器 + 数据）
docker rm gitlab               # 删除容器（保留 volumes 数据）
docker stop gitlab && docker rm gitlab   # 停止并删除容器
```

```bash
# 彻底清理（不可逆：删除容器 + 数据卷）
docker stop gitlab
docker rm gitlab
rm -rf ~/gitlab-compose/volumes
```

## 常用运维

```bash
# 查看日志
docker logs -f gitlab

# 进入容器
docker exec -it gitlab bash

# GitLab 组件状态
docker exec -it gitlab gitlab-ctl status

# 重启
docker restart gitlab

# 仅重读配置（不重启容器）
docker exec -it gitlab gitlab-ctl reconfigure

# 备份
docker exec -it gitlab gitlab-backup create
# 备份文件在 ~/gitlab-compose/volumes/data/backups/

# 恢复（指定备份时间戳）
docker exec -it gitlab gitlab-backup restore BACKUP=<timestamp>
```

## 端口说明

| 主机端口 | 容器用途 | 说明               |
| -------- | -------- | ------------------ |
| 8929     | HTTP     | Web 访问 + API     |
| 2424     | SSH      | `git clone git@...` |

访问地址: `http://localhost:8929`

## 资源限制 (可选)

```bash
docker run ... --memory 6g --cpus 2 ... gitlab/gitlab-ee:latest
```
