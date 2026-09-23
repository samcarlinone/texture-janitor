import { Eraser, History, Sparkles, SquareDashed, type LucideIcon } from 'lucide-react'
import type { SpectrumTool } from './spectrumPane.ts'

export interface ToolDef {
  id: SpectrumTool
  label: string
  key: string
  hint: string
  icon: LucideIcon
  /** Colour role, matching the edit tint in the spectrum view. */
  tone: 'cut' | 'boost' | 'accent'
}

export const TOOLS: ToolDef[] = [
  { id: 'attenuate', label: 'Attenuate', key: 'E', hint: 'Scale magnitude toward zero', icon: Eraser, tone: 'cut' },
  { id: 'amplify', label: 'Amplify', key: 'A', hint: 'Boost magnitude', icon: Sparkles, tone: 'boost' },
  { id: 'restore', label: 'Restore', key: 'R', hint: 'Paint the original spectrum back', icon: History, tone: 'accent' },
  {
    id: 'select',
    label: 'Select',
    key: 'S',
    hint: 'Select frequencies to see where they live in the image',
    icon: SquareDashed,
    tone: 'accent',
  },
]

/** CSS colour of each tone (see index.css). */
export const TONE_COLOR: Record<ToolDef['tone'], string> = {
  cut: '#ff6040',
  boost: '#4ade80',
  accent: '#5ee0ff',
}
