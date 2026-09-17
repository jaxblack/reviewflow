# ReviewFlow MVP

ReviewFlow 是一个内部内容审核系统 Demo，覆盖内容提交、多角色权限、LOW/HIGH 分级审核、多轮审核快照、幂等和并发终态一致性。

## 技术栈

- React 19 + TypeScript + Vite
- Fastify + Zod
- Node 22.5+ 内置 `node:sqlite`，WAL 模式
- Vitest 集成测试
- 单容器 Docker 部署

## 本地运行

需要 Node.js 22.5 或更高版本。

```bash
npm install
npm run dev
```

- Web：<http://localhost:5173/reviewflow/>
- API：<http://localhost:3001>
- 默认用户：Alice
- 数据文件：`.data/reviewflow.db`

页面右上角可切换预置用户：

| 用户 | 角色 |
| --- | --- |
| Alice | SUBMITTER、REVIEWER |
| Bob | REVIEWER |
| Chen | REVIEWER |
| Diana | ADMIN |

用户切换是 Demo 的轻量身份入口：写接口只从服务端签名 Cookie 获取当前用户，不接受客户端传入 `actorId` 或 `reviewerId`。它不是真实登录系统，因此任何能访问 Demo 的人都能切换预置身份。

## 验证

```bash
npm run check
```

核心测试覆盖：

- LOW 一人通过和 HIGH 两个不同审核人通过。
- 作者不能自审，ADMIN 不自动拥有审核权。
- 拒绝理由必填，任意拒绝结束当前轮次。
- 拒绝后编辑重提，旧轮快照保留且不参与新轮计票。
- 幂等重试和幂等键冲突。
- 同轮终审通过与拒绝竞争时只有一个终态。

## 演示数据

生产构建后可幂等写入九条演示内容：

```bash
npm run build
npm run seed:demo
```

数据覆盖草稿、LOW/HIGH 待审核、LOW/HIGH 已通过、先通过后拒绝、拒绝后修改并重新提交，以及并发终态示例。完整清单见 [演示场景](docs/demo-scenarios.md)。

## 生产运行

```bash
npm run build
NODE_ENV=production \
SESSION_SECRET="$(openssl rand -hex 32)" \
DATA_DIR=.data \
npm start
```

生产模式由 Fastify 同时提供 API 和构建后的静态页面。直接运行时默认监听 `0.0.0.0:3000`；腾讯云 systemd 单元显式设置 `HOST=127.0.0.1`，只允许 Caddy 访问。

## 腾讯云部署

生产入口：<https://qlili.com/reviewflow/>。当前 Demo 允许公开访问，Caddy 剥离 `/reviewflow` 前缀后转发给本机 3000 端口。访问者可以切换预置身份并修改演示数据，不应在其中存放真实业务内容。

参见 [deploy/tencent-cloud.md](deploy/tencent-cloud.md)。当前 MVP 使用本机 SQLite 文件，适合单台云服务器和单个应用实例，不应同时启动多个进程或容器副本。多机部署前应迁移到 PostgreSQL。
