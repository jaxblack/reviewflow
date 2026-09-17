import { FilePlus2, Save, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../api'
import type { ContentInput } from '../types'

interface ContentEditorProps {
  mode: 'create' | 'edit'
  initial?: ContentInput
  busy: boolean
  onClose: () => void
  onSave: (input: ContentInput) => Promise<void>
}

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
    try {
      await onSave({ title, body, risk })
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
            <span>标题</span>
            <input
              value={title}
              maxLength={200}
              required
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label>
            <span>正文</span>
            <textarea
              value={body}
              maxLength={50_000}
              rows={10}
              required
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
          <button type="submit" className="button primary" disabled={busy}>
            <Save aria-hidden="true" />
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}