import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createDatabase, USER_IDS, withImmediateTransaction } from './db.js'
import type { ContentStatus, DecisionType, Risk, RoundStatus } from './types.js'

type Reviewer = 'bob' | 'chen'
type DecisionFixture = [Reviewer, DecisionType, string | null, number]

interface RoundFixture {
  status: RoundStatus
  required: 1 | 2
  startedAgo: number
  completedAgo: number | null
  title?: string
  body?: string
  risk?: Risk
  decisions: DecisionFixture[]
}

interface ContentFixture {
  slug: string
  title: string
  body: string
  risk: Risk
  status: ContentStatus
  version: number
  createdAgo: number
  updatedAgo: number
  rounds: RoundFixture[]
}

const fixtures: ContentFixture[] = [
  {
    slug: 'draft-low', title: '周末运营排期草稿', risk: 'LOW', status: 'DRAFT',
    body: '整理下周末的内容发布时间和负责人，确认后再提交审核。',
    version: 1, createdAgo: 72, updatedAgo: 2, rounds: [],
  },
  {
    slug: 'low-pending', title: '帮助中心文案更新', risk: 'LOW', status: 'IN_REVIEW',
    body: '补充账号安全设置的操作步骤，并统一页面中的按钮名称。',
    version: 2, createdAgo: 54, updatedAgo: 3,
    rounds: [{ status: 'OPEN', required: 1, startedAgo: 3, completedAgo: null, decisions: [] }],
  },
  {
    slug: 'high-pending', title: '隐私政策调整', risk: 'HIGH', status: 'IN_REVIEW',
    body: '更新数据保留期限说明，并增加用户申请导出数据的处理流程。',
    version: 3, createdAgo: 50, updatedAgo: 4,
    rounds: [{
      status: 'OPEN', required: 2, startedAgo: 6, completedAgo: null,
      decisions: [['bob', 'APPROVE', '条款表达清楚，同意进入下一票审核。', 4]],
    }],
  },
  {
    slug: 'low-approved', title: 'FAQ 拼写修订', risk: 'LOW', status: 'APPROVED',
    body: '修正帮助中心三处错别字，不改变原有业务含义。',
    version: 3, createdAgo: 70, updatedAgo: 12,
    rounds: [{
      status: 'APPROVED', required: 1, startedAgo: 14, completedAgo: 12,
      decisions: [['bob', 'APPROVE', '修改范围明确。', 12]],
    }],
  },
  {
    slug: 'high-approved', title: '账户注销流程更新', risk: 'HIGH', status: 'APPROVED',
    body: '新增注销前风险提示、等待期说明和数据清理范围。',
    version: 4, createdAgo: 80, updatedAgo: 18,
    rounds: [{
      status: 'APPROVED', required: 2, startedAgo: 22, completedAgo: 18,
      decisions: [
        ['bob', 'APPROVE', '流程完整。', 20],
        ['chen', 'APPROVE', null, 18],
      ],
    }],
  },
  {
    slug: 'high-rejected', title: '活动规则存在歧义', risk: 'HIGH', status: 'REJECTED',
    body: '积分翻倍活动尚未说明适用地区和退款后的积分处理方式。',
    version: 4, createdAgo: 46, updatedAgo: 16,
    rounds: [{
      status: 'REJECTED', required: 2, startedAgo: 20, completedAgo: 16,
      decisions: [
        ['bob', 'APPROVE', '主体规则可行。', 18],
        ['chen', 'REJECT', '请明确适用地区以及退款后的积分回收规则。', 16],
      ],
    }],
  },
  {
    slug: 'rejected-editable', title: '图片授权说明不足', risk: 'LOW', status: 'REJECTED',
    body: '专题页计划使用合作方提供的图片，当前稿件没有标注授权范围。',
    version: 3, createdAgo: 38, updatedAgo: 10,
    rounds: [{
      status: 'REJECTED', required: 1, startedAgo: 13, completedAgo: 10,
      decisions: [['bob', 'REJECT', '请补充图片授权期限和可使用渠道。', 10]],
    }],
  },
  {
    slug: 'resubmitted', title: '用户通知模板（修订版）', risk: 'HIGH', status: 'APPROVED',
    body: '修订后明确通知对象、发送时间和退订入口，并删除容易误解的表述。',
    version: 8, createdAgo: 96, updatedAgo: 24,
    rounds: [
      {
        status: 'REJECTED', required: 2, startedAgo: 60, completedAgo: 54,
        title: '用户通知模板（初稿）',
        body: '向所有用户发送服务调整通知，具体发送范围和退订方式待补充。',
        decisions: [
          ['bob', 'APPROVE', '通知目的明确。', 58],
          ['chen', 'REJECT', '请补充发送范围、发送时间和退订入口。', 54],
        ],
      },
      {
        status: 'APPROVED', required: 2, startedAgo: 30, completedAgo: 24,
        decisions: [
          ['bob', 'APPROVE', '上一轮问题已处理。', 27],
          ['chen', 'APPROVE', '信息完整，同意发布。', 24],
        ],
      },
    ],
  },
  {
    slug: 'concurrent-terminal', title: '紧急服务公告', risk: 'LOW', status: 'APPROVED',
    body: '说明短时维护窗口、受影响功能和预计恢复时间。',
    version: 3, createdAgo: 32, updatedAgo: 8,
    rounds: [{
      status: 'APPROVED', required: 1, startedAgo: 9, completedAgo: 8,
      decisions: [['bob', 'APPROVE', '终态请求先提交，本轮只保留这一条有效决定。', 8]],
    }],
  },
]

const reviewerNames: Record<Reviewer, string> = { bob: 'Bob', chen: 'Chen' }

function at(baseTime: number, hoursAgo: number): string {
  return new Date(baseTime - hoursAgo * 60 * 60 * 1000).toISOString()
}

export function seedDemoData(database: DatabaseSync, baseTime = Date.now()): {
  insertedContents: number
  totalDemoContents: number
} {
  const insertContent = database.prepare(`
    INSERT OR IGNORE INTO contents
      (id, author_id, title, body, risk, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertRevision = database.prepare(`
    INSERT OR IGNORE INTO content_revisions
      (id, content_id, revision_no, title, body, risk, author_id, author_name_snapshot, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertRound = database.prepare(`
    INSERT OR IGNORE INTO review_rounds
      (id, content_id, revision_id, round_no, required_approvals, status, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertDecision = database.prepare(`
    INSERT OR IGNORE INTO review_decisions
      (id, round_id, reviewer_id, reviewer_name_snapshot, decision, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  let insertedContents = 0
  withImmediateTransaction(database, () => {
    for (const content of fixtures) {
      const contentId = `demo-${content.slug}`
      insertedContents += Number(insertContent.run(
        contentId, USER_IDS.alice, content.title, content.body, content.risk,
        content.status, content.version, at(baseTime, content.createdAgo),
        at(baseTime, content.updatedAgo),
      ).changes)

      content.rounds.forEach((round, roundIndex) => {
        const roundNo = roundIndex + 1
        const revisionId = `${contentId}-revision-${roundNo}`
        const roundId = `${contentId}-round-${roundNo}`
        insertRevision.run(
          revisionId, contentId, roundNo, round.title ?? content.title,
          round.body ?? content.body, round.risk ?? content.risk, USER_IDS.alice,
          'Alice', at(baseTime, round.startedAgo),
        )
        insertRound.run(
          roundId, contentId, revisionId, roundNo, round.required, round.status,
          at(baseTime, round.startedAgo),
          round.completedAgo === null ? null : at(baseTime, round.completedAgo),
        )
        round.decisions.forEach(([reviewer, value, comment, decidedAgo]) => {
          insertDecision.run(
            `${roundId}-decision-${reviewer}`, roundId, USER_IDS[reviewer],
            reviewerNames[reviewer], value, comment, at(baseTime, decidedAgo),
          )
        })
      })
    }
  })

  const result = database
    .prepare("SELECT count(*) AS count FROM contents WHERE id LIKE 'demo-%'")
    .get() as unknown as { count: number }
  return { insertedContents, totalDemoContents: result.count }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  const database = createDatabase()
  try {
    const result = seedDemoData(database)
    console.log(`Demo data ready: ${result.totalDemoContents} contents (${result.insertedContents} inserted).`)
  } finally {
    database.close()
  }
}