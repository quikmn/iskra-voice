// The screen picker: each request the page answers carries its number, so two at once (a stream pop-out and the main
// page, or a quick retry) never take each other's answer, and a newer request cancels one still waiting (no listener
// is left behind when the page never answers).

export class ScreenPicks {
  private seq = 0
  private waiting: { id: number; resolve: (picked: string | null) => void } | null = null

  /** Asks the page (`send` shows the picker with this request's number); resolves with the picked id, or null. */
  ask(send: (requestId: number) => void): Promise<string | null> {
    this.waiting?.resolve(null)
    return new Promise((resolve) => {
      const id = ++this.seq
      this.waiting = { id, resolve }
      send(id)
    })
  }

  /** The page's answer: counts only for the request still waiting. */
  answer(requestId: unknown, picked: unknown): void {
    if (!this.waiting || requestId !== this.waiting.id) return
    const { resolve } = this.waiting
    this.waiting = null
    resolve(typeof picked === 'string' ? picked : null)
  }

  /** The page went away: nothing will answer. */
  cancel(): void {
    this.waiting?.resolve(null)
    this.waiting = null
  }
}
