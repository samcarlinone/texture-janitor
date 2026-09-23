import { GraduationCap } from 'lucide-react'
import { Button } from './Button.tsx'

/** First-visit prompt to start the tour (kept apart from Tutorial.tsx, which is loaded on demand). */
export function TourToast({ onStart, onDismiss }: { onStart: () => void; onDismiss: () => void }) {
  return (
    <div className="tour-toast" role="status">
      <GraduationCap size={18} className="tour-toast-icon" aria-hidden />
      <div>
        <b>New to Texture Janitor?</b>
        <p>Take a one-minute tour: pick out a repeating texture and paint it out of the spectrum.</p>
        <div className="row">
          <Button variant="primary" onClick={onStart}>
            Start tour
          </Button>
          <Button onClick={onDismiss}>Don&apos;t show again</Button>
        </div>
      </div>
    </div>
  )
}
