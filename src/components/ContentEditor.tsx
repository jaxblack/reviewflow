import { FilePlus2, Save, Send, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../api'
import type { ContentInput } from '../types'

interface ContentEditorProps {
  mode: 'create' | 'edit'
  initial?: ContentInput
  busy: boolean
  onClose: () => void
  onSave: (input: ContentInput, intent: ContentSaveIntent) => Promise<void>
}

export type ContentSaveIntent = 'DRAFT' | 'SUBMIT'

export function ContentEditor({
  mode,
  initial,
  busy,
  onClose,
  onSave,
}: ContentEditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [risk, setRisk] = useState<ContentInput['risk']>(initial?.risk ?? 'LOW')
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null
    const intent: ContentSaveIntent =
      submitter?.value === 'SUBMIT' ? 'SUBMIT' : 'DRAFT'
    try {
      await onSave({ title, body, risk }, intent)
    } catch (saveError) {
      setError(errorMessage(saveError))
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="editor-dialog"
      aria-labelledby="editor-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form onSubmit={handleSubmit}>
        <header className="dialog-header">
          <div className="dialog-heading">
            {mode === 'create' ? <FilePlus2 aria-hidden="true" /> : <Save aria-hidden="true" />}
            <div>
              <p className="eyebrow">CONTENT</p>
              <h2 id="editor-title">{mode === 'create' ? '创建内容' : '编辑内容'}</h2>
              <span className="dialog-description">
                {mode === 'create'
                  ? '可以暂存后继续编辑，也可以直接提交进入审核。'
                  : '修改不会改写历史快照；可保存或直接进入新审核轮次。'}
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

        <div className="form-stack">
          <label>
            <span className="field-label">
              标题
              <small>{title.length}/200</small>
            </span>
            <input
              value={title}
              maxLength={200}
              required
              autoFocus
              placeholder="示例：会员续费提醒文案"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label>
            <span className="field-label">
              正文
              <small>{body.length.toLocaleString('zh-CN')}/50,000</small>
            </span>
            <textarea
              value={body}
              maxLength={50_000}
              rows={10}
              required
              placeholder="示例：说明通知对象、生效时间、关键规则和用户可执行的操作。"
              onChange={(event) => setBody(event.target.value)}
            />
          </label>

          <fieldset>
            <legend>风险等级</legend>
            <div className="segmented-control">
              <label>
                <input
                  type="radio"
                  name="risk"
                  value="LOW"
                  checked={risk === 'LOW'}
                  onChange={() => setRisk('LOW')}
                />
                <span>LOW · 一人通过</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="risk"
                  value="HIGH"
                  checked={risk === 'HIGH'}
                  onChange={() => setRisk('HIGH')}
                />
                <span>HIGH · 两人通过</span>
              </label>
            </div>
          </fieldset>
        </div>

        {error && <p className="inline-error">{error}</p>}

        <footer className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button secondary" value="DRAFT" disabled={busy}>
            <Save aria-hidden="true" />
            {busy ? '处理中…' : mode === 'create' ? '暂存草稿' : '保存修改'}
          </button>
          <button
            type="submit"
            className="button primary"
            value="SUBMIT"
            disabled={busy}
          >
            <Send aria-hidden="true" />
            {busy ? '处理中…' : mode === 'create' ? '直接提交审核' : '保存并提交审核'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}