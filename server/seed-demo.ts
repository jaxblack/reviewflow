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

const coreFixtures: ContentFixture[] = [
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

interface SupplementalItem {
  slug: string
  title: string
  body: string
  risk: Risk
  status: ContentStatus
}

const supplementalItems: SupplementalItem[] = [
  { slug: 'homepage-banner', title: '首页横幅文案校对', body: '校对秋季专题首页横幅文案，统一活动日期、权益名称和行动按钮。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'member-benefits', title: '会员权益说明更新', body: '补充会员等级对应的运费减免、专属客服和积分倍率说明。', risk: 'LOW', status: 'IN_REVIEW' },
  { slug: 'data-export-notice', title: '数据导出功能公告', body: '向用户说明数据导出的文件范围、生成时长、下载有效期和安全提醒。', risk: 'HIGH', status: 'DRAFT' },
  { slug: 'release-notes', title: '新版本发布说明', body: '介绍本次搜索体验、消息提醒和订单详情页的功能改进。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'coupon-rules', title: '优惠券使用规则', body: '说明优惠券适用商品、叠加限制、有效期限及订单取消后的返还规则。', risk: 'LOW', status: 'REJECTED' },
  { slug: 'refund-policy', title: '订单退款政策调整', body: '调整退款到账时间、原路退回范围和特殊支付方式的处理说明。', risk: 'HIGH', status: 'APPROVED' },
  { slug: 'community-guidelines', title: '社区公约补充条款', body: '补充骚扰行为、虚假信息和重复营销内容的判定与处置方式。', risk: 'HIGH', status: 'IN_REVIEW' },
  { slug: 'support-auto-reply', title: '客服自动回复模板', body: '整理非工作时间的自动回复，并提供紧急问题的自助处理入口。', risk: 'LOW', status: 'DRAFT' },
  { slug: 'marketing-message', title: '营销短信发送方案', body: '明确短信发送对象、发送频次、退订方式和用户授权依据。', risk: 'HIGH', status: 'REJECTED' },
  { slug: 'invoice-guide', title: '发票申请指南', body: '更新电子发票开具步骤、抬头修改时限和常见失败原因。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'teen-mode', title: '青少年模式说明', body: '说明青少年模式的使用时长、内容限制、监护人验证和退出流程。', risk: 'HIGH', status: 'IN_REVIEW' },
  { slug: 'product-disclaimer', title: '商品详情页免责声明', body: '补充效果展示边界、个体差异提示和第三方检测报告引用说明。', risk: 'HIGH', status: 'APPROVED' },
  { slug: 'holiday-campaign', title: '节日活动推送文案', body: '准备节日活动的站内推送标题、摘要和跳转页面文案。', risk: 'LOW', status: 'DRAFT' },
  { slug: 'partner-authorization', title: '第三方服务授权提示', body: '解释连接第三方服务时共享的数据类型、使用目的和取消授权方法。', risk: 'HIGH', status: 'REJECTED' },
  { slug: 'delivery-area', title: '配送范围调整公告', body: '公布新增配送区域、生效时间及暂不支持配送的特殊地址类型。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'account-alert', title: '账号异常提醒模板', body: '提醒用户识别异常登录，提供设备核验、密码重置和客服申诉入口。', risk: 'HIGH', status: 'IN_REVIEW' },
  { slug: 'points-expiry', title: '积分到期提醒', body: '说明即将到期积分数量、到期时间和可兑换权益范围。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'onboarding-copy', title: '新用户引导文案', body: '优化首次使用时的三步引导，突出搜索、收藏和通知设置。', risk: 'LOW', status: 'DRAFT' },
  { slug: 'live-interaction', title: '直播互动规则', body: '补充直播评论、礼物互动、未成年人消费和违规处置规则。', risk: 'HIGH', status: 'REJECTED' },
  { slug: 'support-hours', title: '售后服务时间调整', body: '更新在线客服服务时段、节假日安排和非工作时间留言方式。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'profile-usage', title: '用户画像使用说明', body: '说明偏好标签的生成依据、推荐用途、保存周期和关闭个性化方法。', risk: 'HIGH', status: 'IN_REVIEW' },
  { slug: 'search-update', title: '搜索功能更新公告', body: '介绍搜索纠错、历史记录管理和结果筛选能力的更新。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'offline-registration', title: '线下活动报名须知', body: '整理报名资格、签到材料、取消方式和现场安全注意事项。', risk: 'LOW', status: 'DRAFT' },
  { slug: 'reporting-policy', title: '内容举报处理规范', body: '明确举报受理范围、证据要求、处理时限和结果反馈机制。', risk: 'HIGH', status: 'APPROVED' },
  { slug: 'partner-showcase', title: '合作伙伴展示文案', body: '更新合作伙伴介绍、品牌名称和案例数据来源说明。', risk: 'LOW', status: 'REJECTED' },
  { slug: 'price-change', title: '价格变动通知模板', body: '说明订阅价格调整幅度、生效时间和存量用户过渡方案。', risk: 'LOW', status: 'IN_REVIEW' },
  { slug: 'child-data', title: '儿童信息保护说明', body: '说明监护人同意、儿童信息收集范围和删除申请处理流程。', risk: 'HIGH', status: 'DRAFT' },
  { slug: 'renewal-reminder', title: '会员续费提醒', body: '明确自动续费日期、扣款金额、提醒方式和关闭路径。', risk: 'HIGH', status: 'APPROVED' },
  { slug: 'community-picks', title: '社区精选推荐语', body: '为本周精选内容撰写简短推荐语，并核对作者署名。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'cross-border-terms', title: '跨境服务条款更新', body: '补充跨境数据处理、服务区域限制和争议解决条款。', risk: 'HIGH', status: 'REJECTED' },
  { slug: 'message-center', title: '消息中心改版公告', body: '介绍消息分类、批量已读和免打扰设置的变化。', risk: 'LOW', status: 'IN_REVIEW' },
  { slug: 'migration-maintenance', title: '数据迁移维护通知', body: '公布维护窗口、受影响功能、数据校验方式和异常反馈渠道。', risk: 'HIGH', status: 'APPROVED' },
  { slug: 'survey-invitation', title: '问卷调研邀请文案', body: '邀请活跃用户参与产品调研，说明耗时、奖励和隐私范围。', risk: 'LOW', status: 'DRAFT' },
  { slug: 'location-permission', title: '位置权限使用说明', body: '解释位置权限用于附近服务、配送地址推荐和区域内容展示。', risk: 'HIGH', status: 'IN_REVIEW' },
  { slug: 'unsubscribe-confirmation', title: '退订确认页文案', body: '确认用户退订结果，并提供通知偏好重新配置入口。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'creator-policy', title: '内容创作者规范', body: '补充原创声明、商业合作披露、引用来源和违规处理要求。', risk: 'HIGH', status: 'REJECTED' },
  { slug: 'payment-method', title: '新增支付方式公告', body: '介绍新增支付渠道、支持范围、退款路径和安全提示。', risk: 'LOW', status: 'APPROVED' },
  { slug: 'risk-notice', title: '风控策略用户告知', body: '说明异常交易核验场景、可能采取的限制措施和申诉渠道。', risk: 'HIGH', status: 'IN_REVIEW' },
  { slug: 'monthly-summary', title: '月度运营总结', body: '汇总本月内容发布、用户反馈和下月优化事项。', risk: 'LOW', status: 'DRAFT' },
]

function createSupplementalFixtures(): ContentFixture[] {
  return supplementalItems.map((item, index) => {
    const updatedAgo = 28 + index * 5
    const required = item.risk === 'HIGH' ? 2 : 1
    let decisions: DecisionFixture[] = []

    if (item.status === 'APPROVED') {
      decisions = item.risk === 'HIGH'
        ? [
            ['bob', 'APPROVE', '内容与规则一致，建议通过。', updatedAgo + 2],
            ['chen', 'APPROVE', '复核完成，同意发布。', updatedAgo],
          ]
        : [['bob', 'APPROVE', '信息准确，可以发布。', updatedAgo]]
    } else if (item.status === 'REJECTED') {
      decisions = item.risk === 'HIGH'
        ? [
            ['bob', 'APPROVE', '主体内容无误。', updatedAgo + 2],
            ['chen', 'REJECT', '关键边界说明不完整，请修改后重新提交。', updatedAgo],
          ]
        : [['bob', 'REJECT', '部分信息缺少依据，请补充后重新提交。', updatedAgo]]
    } else if (item.status === 'IN_REVIEW' && item.risk === 'HIGH' && index % 2 === 0) {
      decisions = [['bob', 'APPROVE', '初审通过，等待第二位审核人。', updatedAgo]]
    }

    const rounds: RoundFixture[] = item.status === 'DRAFT'
      ? []
      : [{
          status: item.status === 'IN_REVIEW' ? 'OPEN' : item.status,
          required,
          startedAgo: updatedAgo + (decisions.length > 0 ? 4 : 0),
          completedAgo: item.status === 'IN_REVIEW' ? null : updatedAgo,
          decisions,
        }]

    return {
      ...item,
      version: item.status === 'DRAFT' ? 1 : 2 + decisions.length,
      createdAgo: updatedAgo + 72 + index * 2,
      updatedAgo,
      rounds,
    }
  })
}

const fixtures: ContentFixture[] = [
  ...coreFixtures,
  ...createSupplementalFixtures(),
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