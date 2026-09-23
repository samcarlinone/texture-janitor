import { FileClock, FolderOpen, Save, SaveAll } from 'lucide-react'
import type { ProjectStatus } from '../project/store.ts'
import { Button } from './Button.tsx'

interface Props {
  status: ProjectStatus
  ready: boolean
  save: () => void
  saveAs: () => void
  open: () => void
  reopen: () => void
  setAutosave: (on: boolean) => void
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Project file controls: save / open .tj projects, autosave. */
export function ProjectPanel({ status: s, ready, save, saveAs, open, reopen, setAutosave }: Props) {
  return (
    <>
      {s.fileName ? (
        <div className="stats">
          <div className="stats-name" title={s.fileName}>
            {s.fileName}
          </div>
          <div>
            {s.saving
              ? 'Saving…'
              : s.lastSaved
                ? `Saved ${time(s.lastSaved)}${s.unsaved ? ' · unsaved changes' : ''}`
                : 'Not saved yet'}
          </div>
        </div>
      ) : (
        <p className="hint">
          Save the project to a .tj file to keep every checkpoint, edit and undo step, and pick up where you left off.
        </p>
      )}
      {s.error && <p className="stats error">{s.error}</p>}
      <div className="row">
        <Button
          icon={Save}
          busy={s.saving}
          variant={s.fileName ? 'default' : 'primary'}
          kbd="⌘S"
          disabled={!ready || s.saving}
          onClick={save}
          title={s.fileName ? `Save to ${s.fileName}` : 'Choose a file and save the project'}
        >
          {s.fileName ? 'Save' : 'Save…'}
        </Button>
        <Button icon={FolderOpen} onClick={open} title="Open a .tj project">
          Open…
        </Button>
      </div>
      {s.supported && s.fileName && (
        <Button block icon={SaveAll} disabled={!ready || s.saving} onClick={saveAs} title="Save a copy to a new file and keep working in it">
          Save as…
        </Button>
      )}
      {s.reopenable && !s.fileName && (
        <Button block icon={FileClock} onClick={reopen} title="Reopen the project from your last visit">
          Reopen {s.reopenable}
        </Button>
      )}
      {s.supported ? (
        <label className="check compact-toggle-like">
          <input
            type="checkbox"
            checked={s.autosave}
            disabled={!s.fileName}
            onChange={(e) => setAutosave(e.target.checked)}
          />
          <span>Autosave every 30 s{s.fileName ? '' : ' (after the first save)'}</span>
        </label>
      ) : (
        <p className="hint">
          This browser can&apos;t write to files directly, so Save downloads a .tj file and there&apos;s no autosave.
        </p>
      )}
    </>
  )
}
