import { randomBytes } from 'node:crypto'

export class SessionRecovery {
  constructor({ snapshot, send, report = console.error, schedule = setTimeout, unschedule = clearTimeout }) {
    Object.assign(this, { snapshot, send, report, schedule, unschedule })
    this.attempts = 0
    this.seen = new Set()
    this.automatic = new Set()
    this.version = 0
  }
  cancel(reset = false) {
    this.version++
    if (this.timer !== undefined) this.unschedule(this.timer)
    this.timer = undefined
    if (reset) { this.attempts = 0; this.seen.clear() }
  }
  observe({ id, messages, busy }) {
    const user = messages.findLast(m => m.info.role === 'user' && !this.automatic.has(m.info.id))?.info.id
    if (user !== this.user) { this.cancel(true); this.user = user }
    const last = messages.at(-1)?.info
    if (busy || last?.role !== 'assistant' || !last.time?.completed) { this.cancel(); return }
    if (!last.error) { this.cancel(); return }
    const data = last.error.data
    const eligible = last.error.name === 'APIError' && (data?.isRetryable || /Invalid upload request/i.test(data?.message || ''))
    if (!eligible) { this.cancel(); return }
    if (this.seen.has(last.id)) return
    this.cancel()
    this.seen.add(last.id)
    if (this.attempts >= 5) { this.report('Automatic recovery exhausted: five Continue attempts.'); return }
    const version = this.version
    this.timer = this.schedule(async () => {
      this.timer = undefined
      try {
        const current = await this.snapshot(id)
        if (version !== this.version || current.busy || current.messages.at(-1)?.info.id !== last.id) return
        // Match OpenCode's ascending 48-bit timestamp prefix for message ordering.
        const prefix = ((BigInt(Date.now()) * 4096n + 1n) & 0xffffffffffffn).toString(16).padStart(12, '0')
        const messageID = `msg_${prefix}${randomBytes(7).toString('hex')}`
        this.automatic.add(messageID)
        this.attempts++
        this.report(`Automatic recovery ${this.attempts}/5: Continue`)
        await this.send(id, { messageID, agent: last.agent, model: { providerID: last.providerID, modelID: last.modelID }, parts: [{ type: 'text', text: 'Continue' }] })
      } catch (error) { this.report(`Automatic recovery failed: ${error.message}`) }
    }, 30000)
  }
}
