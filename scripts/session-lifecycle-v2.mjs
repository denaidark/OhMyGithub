import { classifyV2Event, finishedV2Message } from './opencode-v2-api.mjs'

// Preserve the V1 lifecycle's cancellation and deduplication semantics while
// consuming V2 execution events and V2's newest-first message projection.
export class V2LifecycleBridge {
  constructor({ api, lifecycle, sessionID, onError = error => console.error(error.message) }) {
    Object.assign(this, { api, lifecycle, sessionID, onError })
    this.epoch = 0
    this.busy = false
    this.busyPromise = Promise.resolve()
  }

  async beforePrompt() {
    this.epoch++
    this.busy = true
    this.busyPromise = this.lifecycle.busy()
    await this.busyPromise
  }

  async observe(event) {
    const kind = classifyV2Event(event, this.sessionID)
    if (kind === 'busy') {
      if (!this.busy) await this.beforePrompt()
      else await this.busyPromise
      return
    }
    if (kind === 'completed') await this.reconcile()
    if (kind === 'failed' || kind === 'interrupted') {
      this.epoch++
      this.busy = false
    }
  }

  async reconcile() {
    const epoch = this.epoch
    const snapshot = await this.api.snapshot(this.sessionID)
    if (epoch !== this.epoch) return
    if (snapshot.busy) {
      if (!this.busy) await this.beforePrompt()
      return
    }
    const messageID = finishedV2Message(snapshot)
    if (!messageID) return
    this.busy = false
    Promise.resolve(this.lifecycle.complete(messageID)).catch(this.onError)
  }

  async follow(signal) {
    // Subscribe before reconciling so an execution transition cannot be lost.
    const stream = this.api.events({ signal })[Symbol.asyncIterator]()
    const first = await stream.next()
    if (first.done || first.value?.type !== 'server.connected') throw new Error('V2 event stream did not connect')
    await this.reconcile()
    while (!signal?.aborted) {
      const next = await stream.next()
      if (next.done) return
      await this.observe(next.value)
    }
  }
}

export function isV2MainPrompt(method, url, sessionID) {
  if (method !== 'POST' || !/^ses_[A-Za-z0-9]+$/.test(sessionID)) return false
  const path = String(url).split('?')[0]
  return path === `/api/session/${sessionID}/prompt` || path === `/api/session/${sessionID}/command`
}
