# 腾讯云单机部署

当前实例部署入口为 <https://qlili.com/reviewflow/>，运行方式为用户级 systemd + Node.js，Caddy 负责 HTTPS 和路径前缀剥离。

## 当前服务器部署

项目采用 release 目录和 `current` 软链：

```text
/home/ubuntu/apps/reviewflow/
├── current -> releases/<release-id>
├── releases/<release-id>/
└── shared/
  ├── data/reviewflow.db
  └── reviewflow.env
```

服务定义见 `deploy/reviewflow.service`，Caddy 路由见 `deploy/Caddyfile.reviewflow`。应用只监听本机 `127.0.0.1:3000`，由 Caddy 将 `/reviewflow/*` 剥离为 `/*` 后转发。ReviewFlow 路径公开访问，不加入站点已有的 `basic_auth` matcher。

发布后验证：

```bash
systemctl --user status reviewflow --no-pager
curl --fail http://127.0.0.1:3000/api/health
sudo caddy validate --config /etc/caddy/Caddyfile
curl -I https://qlili.com/reviewflow/
```

最后一条命令应返回 `200`。用户切换仅用于演示，任何访问者都可以修改演示数据，因此不得录入真实业务内容。

生产会话密钥只存放在远端 `shared/reviewflow.env`，权限为 600，不进入仓库。用户切换是 Demo 登录替身，不代表真实认证系统。systemd 单元显式配置写入限流与容量上限；达到上限时应用拒绝写入，避免公开 Demo 持续增长 SQLite 并耗尽同机磁盘。

## GitHub Actions CI/CD

`.github/workflows/ci.yml` 是合并门禁：Pull Request 和 `main` 分支提交会执行 lint、自动化测试、TypeScript/前端生产构建，以及 Docker 容器健康检查。建议在 GitHub 分支保护中要求以下检查通过后才能合并：

- `Lint, test, and build`
- `Build and smoke-test container`

`.github/workflows/deploy-production.yml` 只接收当前仓库 `main` 分支成功完成的 CI，不会部署来自 fork、Pull Request 或其他分支的代码。当前公开 Demo 在 CI 成功后自动发布，不再等待人工审批；Workflow 中保留了对应安全边界的注释。

### 1. 初始化服务器

服务器需要安装 Node.js 22.5 或更高版本、npm、curl，并为部署用户启用 user systemd。目录和生产环境文件只需初始化一次：

```bash
mkdir -p ~/apps/reviewflow/{releases,shared/data}
install -m 600 /dev/null ~/apps/reviewflow/shared/reviewflow.env
secret=$(openssl rand -hex 32)
printf 'SESSION_SECRET=%s\n' "$secret" \
  > ~/apps/reviewflow/shared/reviewflow.env
loginctl enable-linger "$USER"
```

`loginctl enable-linger` 如果被系统策略限制，需要由服务器管理员执行。部署用户必须能使用 `systemctl --user`，但不需要 sudo 发布应用。

### 2. 创建部署密钥

在可信终端生成专用密钥，不要复用个人 SSH 密钥：

```bash
ssh-keygen -t ed25519 -C reviewflow-github-actions \
  -f ./reviewflow-deploy -N ''
ssh-copy-id -i ./reviewflow-deploy.pub ubuntu@SERVER_IP
ssh-keyscan -H SERVER_IP > ./reviewflow-known-hosts
```

在首次接受主机指纹前，应通过云控制台或其他可信渠道核对指纹。配置完成并写入 GitHub 后，删除本地私钥副本。

### 3. 配置 GitHub Environment

在仓库 `Settings > Environments` 创建 `production`：

1. 将部署分支限制为 `main`。
2. 公开 Demo 不配置 required reviewers，使通过 CI 的 `main` 自动发布；接入真实内容前必须重新启用审批。
3. 添加 Environment secrets：

| Secret | 内容 |
| --- | --- |
| `PRODUCTION_HOST` | 服务器域名或 IP |
| `PRODUCTION_USER` | 部署用户，例如 `ubuntu` |
| `PRODUCTION_SSH_PRIVATE_KEY` | `reviewflow-deploy` 私钥全文 |
| `PRODUCTION_SSH_KNOWN_HOSTS` | 已核验的 `known_hosts` 内容 |

`SESSION_SECRET`、数据库文件和 Caddy 配置不放入 GitHub Secrets，也不会被流水线覆盖。

### 4. 发布与回滚

合并到 `main` 后，CI 成功会自动触发 production deployment。流水线以 `<commit-sha>-<run-attempt>` 创建 release，安装锁定的生产依赖，更新 systemd unit，原子切换 `current` 并检查本机健康端点。

自动发布只放宽人工审批，以下门禁仍然强制执行：

- Pull Request 和 `main` 都必须通过 lint、测试、生产构建与容器健康检查。
- CD 再次校验事件必须来自当前仓库的 `main` push，成功的 fork 或 PR CI 无法取得生产 secrets。
- `production` Environment 只允许 `main`，SSH 凭据只存为 Environment secrets。
- 发布按单实例串行执行，不取消正在切换软链或重启 systemd 的任务。
- 健康检查失败自动恢复上一 release；数据库和会话密钥不随 release 覆盖。

如果新版本在 20 秒内未通过健康检查，脚本会自动恢复之前的 `current` 并重启服务。若需要人工回滚，可在服务器执行：

```bash
previous=~/apps/reviewflow/releases/PREVIOUS_RELEASE_ID
ln -s "$previous" ~/apps/reviewflow/.current-rollback
mv -Tf ~/apps/reviewflow/.current-rollback ~/apps/reviewflow/current
systemctl --user restart reviewflow
curl --fail http://127.0.0.1:3000/api/health
```

发布目录不会由自动化任务删除，以免误删仍需回滚的版本。确认版本稳定并完成数据库备份后，可人工保留最近若干 release。

## Docker 备选方案

## 适用范围

当前 MVP 使用 SQLite 和本地持久化卷，部署约束如下：

- 一台腾讯云 CVM 或轻量应用服务器。
- 只运行一个 ReviewFlow 容器副本。
- 建议 Ubuntu 24.04、Docker Engine 和 Docker Compose Plugin。
- 若需要多实例或滚动发布，先迁移 PostgreSQL。
- 用户切换是 Demo 登录替身，不能把站点无保护地暴露到公网。

## 1. 上传项目

在本机仓库根目录执行：

```bash
rsync -av \
  --exclude node_modules \
  --exclude dist \
  --exclude dist-server \
  --exclude .data \
  reviewflow/ ubuntu@SERVER_IP:/opt/reviewflow/
```

## 2. 配置环境

登录服务器后执行：

```bash
cd /opt/reviewflow
cp .env.example .env
secret=$(openssl rand -hex 32)
sed -i "s|replace-with-at-least-32-random-characters|$secret|" .env
```

不要提交或传输已填写真实密钥的 `.env`。

## 3. 构建并启动

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/api/health
```

健康响应应为：

```json
{"status":"ok","database":"sqlite"}
```

## 4. 配置入口

Compose 默认只绑定 `127.0.0.1:3000`，避免绕过 HTTPS 直接暴露会话 Cookie。将 `deploy/nginx.conf.example` 复制到 Nginx 配置目录，替换域名后申请 TLS 证书。

至少选择一种入口保护：

- 在腾讯云安全组中只允许授权访问者的固定公网 IP 访问 80/443。
- 在 Nginx 增加 Basic Auth。密码应由你直接在服务器终端设置，不要发送给 AI：

```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.reviewflow-htpasswd reviewflow
```

对应 Nginx `location /` 增加：

```nginx
auth_basic "ReviewFlow Demo";
auth_basic_user_file /etc/nginx/.reviewflow-htpasswd;
```

HTTPS 生效后修改 `.env`：

```dotenv
COOKIE_SECURE=true
```

然后重启：

```bash
docker compose up -d
```

如果暂时只使用服务器 IP 演示，可以把 `compose.yaml` 的端口绑定改为 `3000:3000`，并在腾讯云安全组开放 TCP 3000。此方式只适合短期演示，`COOKIE_SECURE` 保持 `false`。

## 5. 查看日志与更新

```bash
docker compose logs -f --tail=100
docker compose up -d --build
```

## 6. 备份

先停止写入，再导出 Docker 卷：

```bash
docker compose stop reviewflow
docker run --rm \
  -v reviewflow_reviewflow-data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/reviewflow-data.tgz -C /data .
docker compose start reviewflow
```

恢复前应先保留当前卷副本。生产长期运行时建议增加每日备份和保留策略。
