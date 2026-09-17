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

生产会话密钥只存放在远端 `shared/reviewflow.env`，权限为 600，不进入仓库。用户切换是 Demo 登录替身，不代表真实认证系统。

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
