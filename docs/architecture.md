# ReviewFlow 架构说明

## 技术方案

ReviewFlow MVP 使用模块化单体：React SPA、Fastify API 和 Node.js 内置 SQLite。单个 Node 进程同时提供 API 与生产静态资源，适合单机演示和快速部署。PC Web 采用固定应用导航、唯一请求清单和审计详情三栏布局，ADMIN 用户角色管理使用独立侧滑抽屉。

```mermaid
flowchart LR
    Browser[React Web] -->|Cookie + JSON| API[Fastify API]
    API --> Auth[服务端会话身份]
    API --> Policy[权限与状态机]
    API --> Workspace[统一工作区读模型]
    API --> Admin[用户与角色策略]
    API --> DB[(SQLite WAL)]
```

当前实现保持单实例运行。需要多实例时，应先迁移至 PostgreSQL，再使用数据库行锁协调审核终态。

## 状态机

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> IN_REVIEW: 提交并创建新轮次
    IN_REVIEW --> IN_REVIEW: 通过票数不足
    IN_REVIEW --> APPROVED: 达到通过阈值
    IN_REVIEW --> REJECTED: 任意审核人拒绝
    REJECTED --> IN_REVIEW: 修改后重新提交
```

- DRAFT 和 REJECTED 可以编辑。
- IN_REVIEW 和 APPROVED 不可编辑。
- LOW 需要一位审核人通过，HIGH 需要两位不同审核人通过。
- 作者不能审核自己的内容。
- ADMIN 可以查看全部内容，但不会自动获得审核权限。
- ADMIN 可以创建用户、改名并分配叠加角色；不提供用户删除。

## 数据模型

```mermaid
erDiagram
    USERS ||--o{ USER_ROLES : has
    USERS ||--o{ CONTENTS : creates
    CONTENTS ||--o{ CONTENT_REVISIONS : snapshots
    CONTENTS ||--o{ REVIEW_ROUNDS : owns
    CONTENT_REVISIONS ||--|| REVIEW_ROUNDS : reviewed_as
    REVIEW_ROUNDS ||--o{ REVIEW_DECISIONS : receives
    USERS ||--o{ REVIEW_DECISIONS : makes
```

`contents` 保存当前工作副本；每次提交产生不可变的 `content_revisions` 快照和新的 `review_rounds`。因此后续编辑不会改变历史轮次所审核的内容。

数据库约束包括：

- 每条内容最多一个 OPEN 轮次。
- 每位审核人在同一轮最多一条决定。
- 拒绝理由必须是非空白字符串。
- 轮次状态和完成时间必须一致。
- revision 必须属于对应内容。

## 一致性

所有写操作在服务端校验身份、角色、作者和状态。客户端不能传入可信的 actor 或 reviewer ID。

SQLite 使用 WAL 和 `BEGIN IMMEDIATE` 串行化写事务。审核决定、轮次终态、内容状态和幂等结果在同一个事务中提交。通过与拒绝同时到达时，先提交的事务决定唯一终态，后续请求返回冲突且不留下决定记录。

每个写请求携带 `Idempotency-Key`：

- 相同键和相同请求返回第一次响应。
- 相同键对应不同请求时返回冲突。
- 数据库唯一约束阻止使用新键重复写入同一审核决定。

用户管理写请求采用相同的服务端身份和幂等事务边界。系统始终保留至少一位 ADMIN；撤销 REVIEWER 时，根据每个 OPEN 轮次的剩余通过票数和尚未决定的合法审核人做事务内校验，已有合法决定继续计票。

## 公网滥用与容量边界

公开 Demo 允许切换预置身份，因此不能依赖登录阻止资源滥用。所有写接口共享基于真实客户端 IP 的每分钟限额；应用只信任来自 `127.0.0.1` 或 `::1` 的反向代理地址，避免客户端直接伪造转发头。

数据库同时执行硬容量限制：最多 100 个用户、500 条内容、每条内容 20 个审核轮次和 2,000 条未过期幂等记录。幂等记录保留 24 小时后回收。SQLite `max_page_count` 将主库限制为 128 MiB，保留 8 MiB 写入余量，并通过 WAL 自动检查点和 journal size limit 控制旁路增长。达到任一容量边界时返回 `507 CAPACITY_LIMIT_REACHED`，同一来源写入过快时返回 `429 RATE_LIMITED`；失败请求不会留下业务记录或幂等记录。

## PC 工作台

`GET /api/workspace` 按当前服务端身份合并并去重以下语义队列：

- `MINE`：我发起的请求。
- `PENDING_REVIEW`：当前轮次等待我决定。
- `REVIEWED`：我在任一轮参与过的请求。
- `ADMIN`：管理员可见的全部请求。

前端不会为每个队列复制一份内容。左侧导航提供 `ALL` 及当前角色可访问的语义视角和实时数量；中间清单始终按内容 ID 唯一展示，右侧持续展示工作副本、请求生命周期、最新轮次进度和逐轮不可变审计历史。用户切换时先清空旧列表和详情，再重新获取工作区，避免旧身份内容短暂残留。

清单默认按最近更新时间倒序排列，因此新建、提交、审核或重提的请求会回到当前队列首位。用户也可切换智能优先级、最早更新和标题排序；智能优先级依次考虑高风险待办、普通待办、其他审核中、已拒绝、草稿和已通过。状态/风险组合筛选、快捷筛选、始终可见的重置按钮、`⌘K` 搜索、方向键切换、请求 ID 复制、审计 JSON 导出和成功通知均是前端效率能力，不替代任何服务端权限或状态校验。

内容编辑器提供“暂存草稿”和“直接提交审核”。快捷路径复用现有创建/编辑与提交 API：保存成功后立即以返回版本提交；若第二步失败，页面明确提示“内容已保存，但提交审核失败”，刷新到最新工作副本，不伪装为整体成功。

侧栏额外提供审核中、高风险和已拒绝状态视图，并提供六步新手引导。“创建草稿”和“提交审核”是两个独立步骤，以明确 DRAFT → IN_REVIEW 的状态边界；后续切换 Alice、Bob、Chen、Diana 时直接定位最近更新的请求，不依赖固定标题或搜索文字。当前操作人区域显示中文角色，以及“预置账号”或“自定义账号”来源。`Eva Ramp-up` 等名称是公开验收中创建的自定义用户，不是系统内置账号。

ADMIN 从 PC 左侧“系统 → 用户与权限”进入管理抽屉。抽屉展示成员/角色汇总、成员搜索和角色矩阵；显示名更新只影响当前用户资料，提交快照和审核决定中的姓名快照不会被回写。

## 部署

生产构建由 Fastify 提供，腾讯云实例使用用户级 systemd 保持单实例运行。应用只监听 `127.0.0.1:3000`，Caddy 提供 HTTPS 并将 `/reviewflow/*` 剥离后反向代理到应用。每次激活 release 前会幂等补齐缺失的固定 `demo-*` 数据，不覆盖已有内容；当前固定种子共 56 条，其中 19 条为开放审核。

SQLite 文件位于独立持久化目录，不随 release 替换。生产会话密钥只存放在远端权限为 600 的环境文件中。
