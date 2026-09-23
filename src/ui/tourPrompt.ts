/** Remembers whether the first-visit tour prompt was answered. */
const STORAGE_KEY = 'tj.tour'

/** Has the first-visit prompt been answered (started or dismissed)? */
export function tourPromptAnswered(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export function answerTourPrompt(answer: 'started' | 'dismissed'): void {
  try {
    localStorage.setItem(STORAGE_KEY, answer)
  } catch {
    // Without storage the prompt simply shows again next visit.
  }
}
