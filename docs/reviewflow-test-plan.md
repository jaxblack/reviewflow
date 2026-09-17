# ReviewFlow 测试方案

> **文档定位**：本文是生产化目标测试蓝图。当前仓库已实现其中一部分 Vitest + Fastify inject + SQLite 测试；Testcontainers、PostgreSQL 行锁、故障注入和 Playwright 用例尚未全部落地，实际状态见 [README](../README.md)。

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 测试对象 | ReviewFlow 内容审核系统 |
| 设计基线 | [reviewflow-system-design.md](./reviewflow-system-design.md) |
| 评审基线 | [reviewflow-technical-review.md](./reviewflow-technical-review.md) |
| 测试目标 | 用可重复执行的证据验证权限、多轮历史、幂等和并发一致性 |
| 核心环境 | Vitest、Fastify inject、Testcontainers、PostgreSQL、Playwright |

本文优先验证数据库最终事实。页面按钮是否禁用只能作为交互测试，不能代替服务端权限、状态和并发测试。

---

## 2. 测试目标

1. 证明 14 条业务不变量在正常、异常、重试和并发条件下长期成立。
2. 证明每次提交保存不可变快照，新轮次不会继承旧轮次票数。
3. 证明 LOW/HIGH 审核阈值、自审禁止和任意拒绝规则正确。
4. 证明同一请求重试、换 key 重复操作和多客户端竞态不会产生重复事实。
5. 证明事务中任一点失败都不会留下部分 decision、round、content 或 idempotency 数据。
6. 证明角色切换、统一工作区、详情、历史和管理员页面不会泄露或错误缓存其他用户数据。
7. 证明用户与角色管理不能移除最后管理员，也不能让进行中轮次失去足够的剩余审核人。

## 3. 测试范围

### 3.1 范围内

- 纯领域策略和状态转换。
- Zod/OpenAPI 请求和响应契约。
- Fastify API、会话适配和权限判断。
- Kysely SQL、migration、约束、索引和事务。
- 创建、编辑、提交、审核、查询、历史、统一工作区和管理员用户/角色流程。
- 乐观锁、行锁、幂等、并发和故障回滚。
- React 关键页面及用户切换后的缓存失效。
- 纯文本或 Markdown 的安全输出。

### 3.2 范围外

- 外部身份提供方、邮件或消息通知。
- 删除、撤回、申诉、转派和 SLA。
- 尚未定义目标值的压力、容量和灾备测试。
- PostgreSQL 自身高可用能力。

---

## 4. 质量风险和优先级

| 风险 | 影响 | 优先级 | 主要测试层 |
| --- | --- | ---: | --- |
| 客户端伪造 actor 或 reviewer | 越权写入 | P0 | 契约、集成 |
| 作者自审或 ADMIN 越权审核 | 审核失真 | P0 | 单元、集成、E2E |
| 历史读取当前工作副本 | 审计记录被改写 | P0 | 集成、E2E |
| 并发产生双终态或终态后决定 | 数据矛盾 | P0 | 并发、数据库断言 |
| 旧轮次票数进入新轮次 | 错误通过 | P0 | 集成 |
| 部分事务提交 | 无法解释或恢复 | P0 | 故障注入 |
| 重试生成重复轮次或决定 | 重复业务事实 | P1 | 幂等、并发 |
| 旧标签页覆盖新数据 | 内容丢失 | P1 | 集成、并发 |
| 用户切换后短暂显示旧数据 | 信息泄露 | P1 | 前端、E2E |
| 管理员撤销关键角色导致流程永久卡住 | OPEN 轮次无法完成 | P1 | 集成、事务 |
| 错误码或分页不稳定 | 客户端行为不可靠 | P2 | 契约、集成 |

P0/P1 场景必须作为合并门禁；P2 可以按发布风险决定是否阻断。

---

## 5. 测试环境

### 5.1 环境要求

- Node.js 使用项目声明的受支持版本，依赖由 pnpm 锁文件固定。
- 集成和并发测试由 Testcontainers 启动真实 PostgreSQL。
- PostgreSQL 主版本应与目标部署环境一致。
- 每次测试从 migration 创建的空库开始，再执行固定 seed。
- 数据库存储 UTC 时间，展示层按浏览器本地时区格式化。
- 不使用 SQLite 或内存数据库替代约束和锁测试。

### 5.2 隔离策略

- 单元测试无数据库依赖。
- 普通集成测试可以按用例清理表或使用独立 schema。
- 并发测试不得把两个被测请求包装在同一个外层事务或复用同一连接。
- E2E suite 使用独立数据库和服务实例，避免与开发数据共享。
- 用例不得依赖执行顺序；每个用例显式创建所需 content、revision 和 round。

### 5.3 固定用户

| 用户 | 角色 | 主要用途 |
| --- | --- | --- |
| Alice | SUBMITTER、REVIEWER | 创建内容、验证可审核他人但不能自审 |
| Bob | REVIEWER | 第一审核人 |
| Chen | REVIEWER | 第二审核人 |
| Diana | ADMIN | 查看全部内容、验证 ADMIN 不自动获得审核权 |

种子使用固定 UUID。测试断言使用 UUID 判断身份，显示名只用于验证历史快照。

---

## 6. 测试分层

| 层次 | 目标 | 是否使用 PostgreSQL | 建议工具 |
| --- | --- | ---: | --- |
| 单元测试 | 纯策略、状态机、能力矩阵、输入归一化 | 否 | Vitest |
| 契约测试 | 严格字段、枚举、错误体和 OpenAPI 一致性 | 否 | Vitest + Fastify inject |
| 集成测试 | API、事务、约束、查询和历史 | 是 | Vitest + Testcontainers |
| 并发测试 | 行锁、唯一约束和竞争终态 | 是，独立连接 | Vitest + `pg`/Kysely |
| 故障注入 | 关键事务位置异常后的整体回滚 | 是 | Vitest + 可注入故障点 |
| 端到端测试 | 多角色真实页面主线和缓存边界 | 是 | Playwright |

Fastify API 优先使用 `fastify.inject()`，只有验证真实 Cookie、网络或浏览器行为时才启动监听端口。

---

## 7. 不变量追踪矩阵

| 不变量 | 自动化证据 |
| --- | --- |
| INV-01 身份只来自服务端会话 | API-001、INT-AUTH-001、E2E-002 |
| INV-02 客户端不能指定身份、状态、轮次或票数 | API-001、API-002 |
| INV-03 只有作者且具有 SUBMITTER 可编辑或提交 | UNIT-003、INT-CONTENT-004、INT-SUBMIT-005 |
| INV-04 只有 DRAFT/REJECTED 可编辑或提交 | UNIT-001、INT-CONTENT-002、INT-SUBMIT-005 |
| INV-05 每次提交创建新轮次和不可变快照 | INT-SUBMIT-001、INT-SUBMIT-004、INT-HISTORY-001 |
| INV-06 同一内容最多一个 OPEN 轮次 | DB-001、CONC-005 |
| INV-07 LOW 需要一位非作者审核人通过 | UNIT-002、INT-REVIEW-001 |
| INV-08 HIGH 需要两位不同的非作者审核人通过 | UNIT-002、INT-REVIEW-002、INT-REVIEW-003、CONC-003 |
| INV-09 任意合法拒绝结束轮次且理由非空 | UNIT-004、INT-REVIEW-004、INT-REVIEW-005 |
| INV-10 每位审核人每轮最多一条决定 | DB-002、INT-REVIEW-008、CONC-004 |
| INV-11 已结束轮次不能继续写决定 | INT-REVIEW-010、CONC-001、CONC-002 |
| INV-12 历史票数不进入新轮次 | INT-REVIEW-011、INT-SUBMIT-004 |
| INV-13 一轮只有一个最终结果 | CONC-001、CONC-002、DB-004 |
| INV-14 内容、轮次、决定和幂等结果原子提交 | FAULT-001、FAULT-002、INT-IDEM-004 |

任何设计变更都必须先更新本矩阵，再修改实现。不得出现没有测试归属的新业务规则。

---

## 8. 单元和契约测试

### 8.1 单元测试用例

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| UNIT-001 | 状态允许的命令 | DRAFT/REJECTED 可编辑提交；IN_REVIEW/APPROVED 不可编辑提交 |
| UNIT-002 | 审核阈值 | LOW 为 1，HIGH 为 2；达到前保持 OPEN，达到后 APPROVED |
| UNIT-003 | 角色能力矩阵 | Alice 可创建和审他人；Bob/Chen 不可创建；Diana 只可管理查看 |
| UNIT-004 | 拒绝理由归一化 | null、空串、空格、制表和换行均非法；非空白文本保留或规范化 |
| UNIT-005 | 拒绝优先语义 | OPEN 轮次收到合法 REJECT 后结果为 REJECTED，与已有 APPROVE 数无关 |
| UNIT-006 | capabilities 计算 | 作者、审核人、参与过的审核人和 ADMIN 得到正确能力集合 |

纯策略测试使用表驱动方式覆盖所有角色组合和状态，不通过 mock repository 间接验证。

### 8.2 契约测试用例

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| API-001 | 写请求携带 `actorId`、`authorId` 或 `reviewerId` | 严格 Schema 返回 400，服务层未被调用 |
| API-002 | 请求携带 status、roundNo、requiredApprovals 或未知字段 | 返回 `INVALID_REQUEST`，数据库无变化 |
| API-003 | 枚举、UUID、长度和 expectedVersion 非法 | 状态码和错误体符合 OpenAPI |
| API-004 | REJECT 理由为空白 | 返回 422 `REJECTION_REASON_REQUIRED` |
| API-005 | 未建立会话 | 返回 401 `UNAUTHENTICATED` |
| API-006 | 错误响应结构 | 所有业务错误至少包含稳定 code 和可展示 message |
| API-007 | OpenAPI 漂移 | 路由 Schema 与生成或保存的 OpenAPI 快照一致 |
| API-008 | 非 ADMIN 调用用户管理，或 DTO 携带未知字段/重复角色 | 返回 403 或 400，用户和角色不变 |

---

## 9. PostgreSQL 集成测试

### 9.1 身份和内容操作

| ID | 前置条件与操作 | 预期结果 |
| --- | --- | --- |
| INT-AUTH-001 | 会话为 Alice，请求体伪造 Bob | 新记录作者仍为 Alice，或严格 Schema 直接返回 400 |
| INT-CONTENT-001 | Alice 创建 LOW 草稿 | author=Alice、status=DRAFT、version=1，无 revision/round |
| INT-CONTENT-002 | Alice 编辑 DRAFT 和 REJECTED | 字段更新，版本递增；IN_REVIEW/APPROVED 返回 409 |
| INT-CONTENT-003 | 两次 PATCH 使用同一 expectedVersion | 第一次成功，第二次 `STALE_VERSION`，不覆盖第一次结果 |
| INT-CONTENT-004 | Bob 编辑 Alice 内容或 Bob 创建内容 | 返回 403，数据库无变化 |
| INT-CONTENT-005 | Alice 读取自己的全部状态内容 | 分页稳定，游标翻页无重复或遗漏 |

### 9.2 提交流程

| ID | 前置条件与操作 | 预期结果 |
| --- | --- | --- |
| INT-SUBMIT-001 | Alice 提交 LOW DRAFT | 创建 revision 1、round 1/OPEN/required=1，content=IN_REVIEW，版本递增 |
| INT-SUBMIT-002 | Alice 提交 HIGH DRAFT | required=2，风险和内容快照与提交时工作副本一致 |
| INT-SUBMIT-003 | 可用非作者 REVIEWER 少于阈值 | 返回 422，revision、round、状态和幂等记录均不新增 |
| INT-SUBMIT-004 | Round 1 拒绝后编辑并重提 | 创建 revision 2 和 round 2；round 1 与 revision 1 不变，进度为 0/阈值 |
| INT-SUBMIT-005 | 非作者、无角色、非法状态或旧版本提交 | 分别返回约定错误，数据库无部分记录 |
| INT-SUBMIT-006 | 不修改 REJECTED 工作副本直接重提 | 按默认决定允许，仍创建新的 revision 和 round |
| INT-SUBMIT-007 | 同一提交后检查序号 | revision_no 与 round_no 各自连续且在同一 content 内唯一 |

### 9.3 审核流程

| ID | 前置条件与操作 | 预期结果 |
| --- | --- | --- |
| INT-REVIEW-001 | Bob APPROVE LOW | 一条决定，round/content 同时 APPROVED，completed_at 非空 |
| INT-REVIEW-002 | Bob APPROVE HIGH | 进度 1/2，round 仍 OPEN，content 仍 IN_REVIEW |
| INT-REVIEW-003 | Bob、Chen 依次 APPROVE HIGH | 两条不同审核人决定，round/content 同时 APPROVED |
| INT-REVIEW-004 | HIGH 已有一票，Chen 合法 REJECT | 两条历史决定保留，唯一终态为 REJECTED |
| INT-REVIEW-005 | Bob 以空白理由 REJECT | 返回 422，无 decision 或状态变化 |
| INT-REVIEW-006 | Alice 审核自己提交的内容 | 返回约定的 403 或 409，数据库无 decision |
| INT-REVIEW-007 | Diana 仅有 ADMIN 时审核 | 返回 403 `ROLE_REQUIRED`，但仍可读取管理员详情 |
| INT-REVIEW-008 | Bob 用新 key 重复相同决定 | 返回已有 decision，标记 replayed，不新增记录 |
| INT-REVIEW-009 | Bob 用新 key 将已有 APPROVE 改为 REJECT | 返回 409 `ALREADY_DECIDED`，原决定不变 |
| INT-REVIEW-010 | 其他审核人在轮次结束后提交决定 | 返回 409 `ROUND_CLOSED`，decision 数不变 |
| INT-REVIEW-011 | Round 1 有 APPROVE，拒绝后进入 Round 2 | Round 2 的 approvalCount 初始为 0 |

INT-REVIEW-008 必须覆盖“第一次决定本身关闭了 LOW 轮次”的情况，以验证服务先识别本人已有决定，再拒绝新的终态写入。

### 9.4 历史、队列和可见性

| ID | 前置条件与操作 | 预期结果 |
| --- | --- | --- |
| INT-HISTORY-001 | Round 1 标题 A 被拒，工作副本改为 B 并提交 Round 2 | Round 1 始终展示 A，Round 2 展示 B |
| INT-HISTORY-002 | 提交或审核后修改用户显示名 | 历史显示操作发生时的姓名快照 |
| INT-QUERY-001 | Bob 查询待审列表 | 只含 OPEN + IN_REVIEW、非 Bob 创建、Bob 尚未决定的内容 |
| INT-QUERY-002 | Bob 完成审核后查询待审列表 | 对应 round 消失，但 Bob 仍可查看参与过的完整历史 |
| INT-QUERY-003 | Diana 查询管理员列表 | 可查看所有状态和历史，但 capabilities.canReview=false |
| INT-QUERY-004 | 无关用户读取不可见内容 | 按统一策略返回 403 或 404，不泄漏内容元数据 |
| INT-QUERY-005 | 多条相同时间戳记录分页 | `(timestamp, id)` 游标排序稳定，无重复或遗漏 |
| INT-QUERY-006 | Alice 同时拥有提交和审核角色，查询统一工作区 | 内容按 ID 去重，并正确标记 MINE、PENDING_REVIEW、REVIEWED 队列归属 |

### 9.5 用户与角色管理

| ID | 前置条件与操作 | 预期结果 |
| --- | --- | --- |
| INT-ADMIN-001 | Diana 创建用户并分配多个角色 | 新用户可被切换，角色按叠加语义生效 |
| INT-ADMIN-002 | Alice 调用 ADMIN 用户管理 API | 返回 403，数据库无变化 |
| INT-ADMIN-003 | 尝试移除唯一 ADMIN | 返回 409 `LAST_ADMIN_REQUIRED` |
| INT-ADMIN-004 | OPEN HIGH 尚需两票，移除一位必要 REVIEWER | 返回 409 `ROLE_CHANGE_WOULD_BLOCK_OPEN_ROUND` |
| INT-ADMIN-005 | REVIEWER 已给出第一票，剩余审核人足以完成 HIGH，再撤销其角色 | 允许撤销；已有合法票继续计入当前轮 |
| INT-ADMIN-006 | 修改用户显示名后读取旧轮次 | 当前用户显示新名称，历史作者/审核人仍显示姓名快照 |
| INT-ADMIN-007 | 创建或改名为已有名称（忽略大小写） | 返回 409 `USER_NAME_EXISTS` |

### 9.6 幂等测试

| ID | 前置条件与操作 | 预期结果 |
| --- | --- | --- |
| INT-IDEM-001 | 相同 key、方法、路径和 body 重试提交 | 状态码和响应体与首次相同，只存在一个 round |
| INT-IDEM-002 | 同一 actor/operation/key 改变 path 或 body | 返回 409 `IDEMPOTENCY_KEY_REUSED`，不执行第二个业务操作 |
| INT-IDEM-003 | 相同 key 重试审核决定 | 返回原 decision 和终态，不新增记录 |
| INT-IDEM-004 | 首次请求事务失败后使用同 key 重试 | 失败事务无幂等记录；修复故障后重试可以正常执行一次 |
| INT-IDEM-005 | 不同 actor 使用相同 key | 两者按各自作用域处理，不发生错误冲突 |

---

## 10. 数据库约束测试

约束测试应通过受控的直接 SQL 尝试写入非法数据，证明防线真实存在，而不是再次调用已校验的服务。

| ID | 非法写入 | 预期数据库结果 |
| --- | --- | --- |
| DB-001 | 为同一 content 插入第二个 OPEN round | 命中部分唯一索引并失败 |
| DB-002 | 同一 reviewer 在同一 round 插入第二条 decision | 命中联合唯一约束并失败 |
| DB-003 | 插入空白 REJECT comment | 命中 CHECK 并失败 |
| DB-004 | OPEN 设置 completed_at，或终态不设置 completed_at | 命中 completion CHECK 并失败 |
| DB-005 | round 引用其他 content 的 revision | 命中组合外键并失败 |
| DB-006 | 插入零或负 round_no/revision_no/version | 命中 CHECK 并失败 |
| DB-007 | 应用运行账号 UPDATE/DELETE revision 或 decision | 权限被拒绝 |

测试结束后还应运行以下不变量探针；任一查询返回行都表示 suite 失败：

```sql
-- 同一内容存在多个 OPEN 轮次
SELECT content_id
FROM review_rounds
WHERE status = 'OPEN'
GROUP BY content_id
HAVING count(*) > 1;

-- 同一审核人在一轮有多条决定
SELECT round_id, reviewer_id
FROM review_decisions
GROUP BY round_id, reviewer_id
HAVING count(*) > 1;

-- 作者审核自己的内容
SELECT rd.id
FROM review_decisions rd
JOIN review_rounds rr ON rr.id = rd.round_id
JOIN contents c ON c.id = rr.content_id
WHERE rd.reviewer_id = c.author_id;

-- APPROVED 轮次未达到票数，或 REJECTED 轮次没有拒绝决定
SELECT rr.id
FROM review_rounds rr
LEFT JOIN review_decisions rd ON rd.round_id = rr.id
GROUP BY rr.id
HAVING
    (rr.status = 'APPROVED' AND count(*) FILTER (WHERE rd.decision = 'APPROVE') < rr.required_approvals)
    OR
    (rr.status = 'REJECTED' AND count(*) FILTER (WHERE rd.decision = 'REJECT') = 0);
```

---

## 11. 并发测试

### 11.1 执行方法

每个并发用例必须满足：

1. 使用至少两个独立 PostgreSQL 连接和独立事务。
2. 在服务事务进入锁竞争点前使用测试屏障同步请求。
3. 同时释放请求，使其竞争同一 content/round 行锁。
4. 为测试连接设置合理的 `lock_timeout` 和整体测试超时，失败时打印锁等待信息。
5. 同时断言 HTTP/服务结果和事务提交后的数据库事实。

仅使用普通 `Promise.all()` 不能证明两个请求曾在关键区间竞争。屏障可以通过测试环境下注入的 no-op hook 实现，也可以由协调连接预先持有目标行锁，确认两个请求进入等待后再释放。测试能力不得暴露为生产 HTTP 接口。

### 11.2 并发用例

| ID | 竞争操作 | 预期结果 |
| --- | --- | --- |
| CONC-001 | LOW 的 APPROVE 与 REJECT | 一个成功形成唯一终态，另一个 409；只存在成功方 decision |
| CONC-002 | HIGH 已有一票时，第二票 APPROVE 与 REJECT | 一个成功形成唯一终态，另一个 409；content 与 round 一致 |
| CONC-003 | HIGH 的两个不同审核人同时 APPROVE | 两条 decision，最终 APPROVED，进度 2/2 |
| CONC-004 | 同一审核人用两个 key 同时决定 | 最多一条 decision；相同语义重放或冲突语义 409 |
| CONC-005 | 同一 content 被两个请求同时提交 | 只创建一个 OPEN round；另一个重放或返回状态/版本冲突 |
| CONC-006 | PATCH 与 submission 同时操作同一 content | 提交最新编辑，或其中一个返回 409；IN_REVIEW 内容没有提交后的编辑 |
| CONC-007 | 两个标签页用相同版本 PATCH | 恰好一个成功，另一个 `STALE_VERSION` |

### 11.3 稳定性要求

- 每个并发用例在普通 CI 至少执行一次确定性屏障测试。
- 合入前或 nightly 将并发 suite 重复执行至少 20 次。
- 不允许用增加随机 sleep 修复偶发失败；必须控制进入临界区的时机。
- 任一次失败都保存两个请求的结果、目标 ID、事务阶段和最终数据库快照。

---

## 12. 故障注入和原子回滚

### 12.1 注入方式

命令服务接受仅测试环境可配置的 `FailureInjector`，生产实现默认为 no-op。注入点位于事务内部，不修改业务 SQL，也不暴露外部路由。

### 12.2 用例

| ID | 注入位置 | 回滚断言 |
| --- | --- | --- |
| FAULT-001 | 插入 review_decision 后、更新 round 前 | decision 不存在；round OPEN；content IN_REVIEW；无幂等结果 |
| FAULT-002 | 更新 round/content 后、保存幂等响应前 | 状态更新和 decision 全部回滚；无幂等结果 |
| FAULT-003 | 插入 revision 后、插入 round 前 | revision 不存在；content 保持原状态和版本 |
| FAULT-004 | 插入 round 后、更新 content 前 | round 和 revision 均不存在；content 未进入 IN_REVIEW |
| FAULT-005 | 保存幂等结果后、COMMIT 前 | 业务事实和幂等结果全部回滚 |

每个用例在移除故障后使用同一幂等 key 重试，必须成功执行一次，证明失败事务没有留下阻塞重试的半成品记录。

---

## 13. 乐观锁专项测试

| ID | 场景 | 预期结果 |
| --- | --- | --- |
| LOCK-001 | 旧标签页在另一标签完成 PATCH 后再保存 | 返回 409，不覆盖新正文 |
| LOCK-002 | 旧标签页在内容提交为 IN_REVIEW 后再保存 | 返回 409 `INVALID_STATE` 或 `STALE_VERSION` |
| LOCK-003 | 内容经历提交、拒绝后重新变为可编辑，旧标签页再保存 | 返回 409 `STALE_VERSION`，不能因状态恢复为 REJECTED 而成功 |
| LOCK-004 | 使用旧版本重新提交 REJECTED 内容 | 返回 409，不创建 revision 或 round |

LOCK-003 是版本策略的关键回归测试。提交和拒绝等状态变化必须推进聚合版本，确保旧客户端视图永久失效。

---

## 14. 端到端测试

### 14.1 E2E-001：两轮完整审核主线

1. 切换 Alice，创建 HIGH 内容并提交。
2. Alice 详情页无审核操作，待审列表不包含自己的内容。
3. 切换 Bob，给出 APPROVE，详情显示“1 / 2 已通过”，内容仍在审核中。
4. 切换 Chen，给出带理由 REJECT，内容变为 REJECTED。
5. 切换 Alice，修改标题或正文并重新提交。
6. 切换 Bob 和 Chen，分别 APPROVE 第二轮，内容最终 APPROVED。
7. 切换 Diana，查看两个轮次、不同 revision 和全部决定。
8. 验证 Diana 没有审核按钮或审核 API 权限。

### 14.2 E2E-002：会话切换与缓存隔离

1. Alice 打开“我的内容”和详情。
2. 切换为 Bob。
3. 用户相关 TanStack Query cache 被清除或失效。
4. 页面加载期间不得继续展示 Alice 的正文或可执行操作。
5. Bob 只能看到符合可见性规则的队列和历史。

### 14.3 E2E-003：拒绝表单和冲突恢复

1. 空白理由不能提交，并显示服务端一致的错误信息。
2. 两个浏览器上下文打开同一 OPEN round。
3. 一方完成审核后，另一方提交得到 409。
4. 客户端刷新详情并移除失效操作，不伪装为成功。

E2E 重点验证用户可观察行为；数据库并发正确性仍由集成和并发 suite 负责。

### 14.4 E2E-004：PC 管理中心

1. 使用常用 PC 视口切换 Diana，左侧系统导航出现“用户与权限”入口。
2. 管理抽屉展示成员/角色汇总、搜索、四个预置用户的角色、内容数和审核次数。
3. 创建一个 SUBMITTER + REVIEWER 用户，用户立即出现在切换入口。
4. 尝试移除最后 ADMIN 或开放 HIGH 轮次所需 REVIEWER，页面显示服务端冲突信息。
5. 为 Diana 叠加 REVIEWER 后，她可审核非本人内容；移除后审核入口消失。

### 14.5 E2E-005：PC 工作台效率

1. 以 Bob 打开工作台，默认优先展示高风险待审核请求。
2. 聚焦“待我审核”并选择“高风险”快捷筛选，列表只保留匹配请求且同一内容不重复。
3. 切换智能优先级、更新时间和标题排序，当前选中请求保持稳定。
4. 使用 `⌘K` 或 `/` 聚焦搜索，方向键切换当前结果并同步刷新右侧详情。
5. 导出审计记录，下载文件名包含请求 ID，JSON 只包含当前详情 API 已授权返回的数据。
6. 创建、提交、审核和身份切换后出现明确反馈；失败响应不得显示成功通知。

本轮产品验收只覆盖 PC 三栏工作台和 PC 管理抽屉；移动视口属于后续适配，不作为当前退出条件。

---

## 15. 安全和输出测试

| ID | 场景 | 预期结果 |
| --- | --- | --- |
| SEC-001 | 标题、正文或评论包含 `<script>`、事件属性等文本 | 页面不执行脚本，内容按纯文本或经过允许列表清洗的 Markdown 展示 |
| SEC-002 | 修改 Cookie 之外的前端用户名或请求 actor 字段 | 实际身份仍由服务端会话决定 |
| SEC-003 | 枚举随机 content/round UUID | 不返回不可见资源内容，错误策略一致 |
| SEC-004 | 应用账号尝试 DDL、修改角色或删除历史 | PostgreSQL 权限拒绝 |
| SEC-005 | 超长标题、正文、评论和幂等键 | 按契约拒绝，不导致 500 或截断后误接受 |

日志不得记录会话凭据、完整 Cookie 或数据库密码。业务日志可以记录 request ID、actor ID、content ID、round ID、operation 和结果码。

---

## 16. 非功能性检查

当前没有正式性能 SLA，因此只做防退化检查，不把任意吞吐数字写成验收承诺：

- 列表查询通过 `EXPLAIN` 确认能使用作者、状态或 OPEN 队列索引。
- 历史查询不会对每个 round 分别发起 revision/decision 查询，避免明显 N+1。
- 所有列表都有上限和稳定分页，不允许无界返回全部内容。
- 锁只覆盖单次命令事务，事务内不调用外部网络服务。
- 幂等清理按索引分批执行，不长时间锁住业务表。
- Playwright 在 1280×800、1440×900 和 1600×1000 PC 视口检查三栏工作台与管理抽屉无页面级横向溢出、遮挡或不可操作控件；移动视口后续单独验收。

---

## 17. CI 执行顺序

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:concurrency
pnpm test:e2e
```

建议根目录增加 `pnpm verify` 顺序聚合以上命令，但各子命令仍应可独立执行和定位失败。推荐门禁：

| 阶段 | 执行内容 |
| --- | --- |
| Pull Request | lint、typecheck、unit、contract、integration、concurrency |
| 主分支 | PR 全部内容 + build + E2E |
| Nightly | concurrency 重复运行、完整 E2E、索引和不变量探针 |

测试失败时 CI 必须保留服务日志、PostgreSQL 日志、Playwright trace 和失败数据库快照或探针结果。

---

## 18. 进入和退出标准

### 18.1 进入标准

- 需求不变量和默认决定已冻结。
- migration、seed 和测试数据工厂可用。
- API 错误码和会话切换方式已定义。
- 并发屏障和故障注入点经过代码评审，仅在测试环境启用。

### 18.2 退出标准

- 14 条不变量均有自动化用例且全部通过。
- 所有 P0/P1 用例通过，无未处理的偶发失败。
- 并发 suite 重复运行至少 20 次无失败。
- 故障注入用例证明业务记录和幂等记录整体回滚。
- 数据库不变量探针返回零行。
- E2E 主线在受支持浏览器和视口通过。
- 无未关闭 P0/P1 缺陷；P2 缺陷已有负责人和计划。

---

## 19. 测试报告模板

```markdown
# ReviewFlow 测试报告

- 测试版本或 commit：
- PostgreSQL 版本：
- 执行时间：
- 执行环境：本地 / CI

## 结果汇总

| Suite | 通过 | 失败 | 跳过 | 耗时 | 证据 |
| --- | ---: | ---: | ---: | ---: | --- |
| Unit |  |  |  |  |  |
| Contract |  |  |  |  |  |
| Integration |  |  |  |  |  |
| Concurrency |  |  |  |  |  |
| Fault injection |  |  |  |  |  |
| E2E |  |  |  |  |  |

## 不变量结果

| 不变量 | 结果 | 对应用例 | 备注 |
| --- | --- | --- | --- |

## 缺陷

| ID | 级别 | 场景 | 影响 | 状态 | 负责人 |
| --- | --- | --- | --- | --- | --- |

## 最终结论

通过 / 有条件通过 / 不通过
```

测试报告必须绑定具体 commit 和 migration 版本，避免使用旧测试结果为新实现背书。
