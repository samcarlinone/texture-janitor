import { readPref, writePref } from './storage.ts'

/** Remembers whether the first-visit tour prompt was answered. */
const STORAGE_KEY = 'tj.tour'

/** Has the first-visit prompt been answered (started or dismissed)? Without storage it shows again next visit. */
export function tourPromptAnswered(): boolean {
  return readPref(STORAGE_KEY) !== null
}

export function answerTourPrompt(answer: 'started' | 'dismissed'): void {
  writePref(STORAGE_KEY, answer)
}
