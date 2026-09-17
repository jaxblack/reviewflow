import {
  CheckCircle2,
  FilePlus2,
  History,
  Pencil,
  Send,
  ShieldCheck,
  UserCheck,
  X,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Risk, WorkspaceScope } from '../types'

export interface GuideTarget {
  userId: string
  scope: WorkspaceScope
  query: string
  status: 'ALL' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED'
  risk: 'ALL' | Risk
  action?: 'CREATE' | 'SUBMIT' | 'ADMIN'
}

interface OnboardingGuideProps {
  busy: boolean
  onClose: () => void
  onStart: (target: GuideTarget) => Promise<void>
}

const guideSteps: Array<{
  actor: string
  role: string
  title: string
  icon: typeof Send
  operations: string[]
  expected: string
  target: GuideTarget
}> = [
  {
    actor: 'Alice',
    role: '提交人',
    title: '创建草稿',
    icon: FilePlus2,
    operations: [
      '填写标题、正文和风险等级并保存草稿。',
      '确认详情状态仍为“草稿”，内容可以继续编辑。',
    ],
    expected: '内容保持 DRAFT，尚未产生审核轮次和不可变快照。',
    target: {
      userId: 'user-alice',
      scope: 'MINE',
      query: '',
      status: 'ALL',
      risk: 'ALL',
      action: 'CREATE',
    },
  },
  {
    actor: 'Alice',
    role: '提交人',
    title: '提交审核',
    icon: Send,
    operations: [
      '保持刚创建的草稿，或打开“周末运营排期草稿”。',
      '在详情确认工作副本后点击“提交审核”。',
    ],
    expected: '内容进入 IN_REVIEW，并创建 R1 不可变快照。',
    target: {
      userId: 'user-alice',
      scope: 'MINE',
      query: '周末运营排期草稿',
      status: 'DRAFT',
      risk: 'ALL',
      action: 'SUBMIT',
    },
  },
  {
    actor: 'Bob',
    role: '审核人',
    title: '完成 LOW 风险审核',
    icon: UserCheck,
    operations: [
      '进入“待我审核”，打开“服务状态页公告”。',
      '填写可选意见并点击“通过”。',
    ],
    expected: 'LOW 内容达到 1/1，轮次和内容同时变为 APPROVED。',
    target: {
      userId: 'user-bob',
      scope: 'PENDING_REVIEW',
      query: '服务状态页公告',
      status: 'ALL',
      risk: 'ALL',
    },
  },
  {
    actor: 'Chen',
    role: '审核人',
    title: '验证 HIGH 风险拒绝',
    icon: Send,
    operations: [
      '打开高风险的“AI 内容使用说明”。',
      '填写非空理由后点击“拒绝”。',
    ],
    expected: '任意合法拒绝立即结束 R1，拒绝理由完整保留在历史。',
    target: {
      userId: 'user-chen',
      scope: 'PENDING_REVIEW',
      query: 'AI 内容使用说明',
      status: 'ALL',
      risk: 'ALL',
    },
  },
  {
    actor: 'Alice',
    role: '提交人',
    title: '修改并重新提交',
    icon: Pencil,
    operations: [
      '在“我的提交”筛选已拒绝内容。',
      '编辑正文或风险后保存，再点击“重新提交”。',
    ],
    expected: '创建全新的审核轮次，旧轮决定不计入新轮票数。',
    target: {
      userId: 'user-alice',
      scope: 'MINE',
      query: '图片授权说明不足',
      status: 'REJECTED',
      risk: 'ALL',
    },
  },
  {
    actor: 'Diana',
    role: '管理员',
    title: '审计历史与管理权限',
    icon: ShieldCheck,
    operations: [
      '查看“用户通知模板（修订版）”的两轮快照。',
      '从“用户与权限”确认预置和自定义账号及角色。',
    ],
    expected: 'ADMIN 可查看和管理，但没有 REVIEWER 时不出现审核操作。',
    target: {
      userId: 'user-diana',
      scope: 'ALL',
      query: '用户通知模板',
      status: 'ALL',
      risk: 'ALL',
      action: 'ADMIN',
    },
  },
]

export function OnboardingGuide({
  busy,
  onClose,
  onStart,
}: OnboardingGuideProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="guide-dialog"
      aria-labelledby="guide-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header className="dialog-header guide-header">
        <div className="dialog-heading">
          <CheckCircle2 aria-hidden="true" />
          <div>
            <p className="eyebrow">GUIDED ACCEPTANCE</p>
            <h2 id="guide-title">六步完成核心验收</h2>
            <span className="dialog-description">
              每一步都会切换到对应角色并定位示例数据。
            </span>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          title="关闭"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="guide-intro">
        <History aria-hidden="true" />
        <p>
          公开 Demo 会保留你的操作。建议先阅读预期结果，再进入步骤；需要完整书面版本可打开
          <a href={`${import.meta.env.BASE_URL}docs/acceptance-report.html#guided-acceptance`}>
            验收报告
          </a>
          。
        </p>
      </div>

      <ol className="guide-steps">
        {guideSteps.map((step, index) => {
          const StepIcon = step.icon
          return (
            <li key={step.title}>
              <span className="guide-step-number">{index + 1}</span>
              <div className="guide-step-content">
                <header>
                  <span className="guide-step-icon">
                    <StepIcon aria-hidden="true" />
                  </span>
                  <span>
                    <small>{step.actor} · {step.role}</small>
                    <strong>{step.title}</strong>
                  </span>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void onStart(step.target)}
                  >
                    进入步骤
                  </button>
                </header>
                <ol>
                  {step.operations.map((operation) => (
                    <li key={operation}>{operation}</li>
                  ))}
                </ol>
                <p>
                  <CheckCircle2 aria-hidden="true" />
                  <span><strong>预期：</strong>{step.expected}</span>
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </dialog>
  )
}
