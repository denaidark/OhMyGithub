import { createV2Proxy } from './opencode-v2-proxy.mjs'

const [port, sessionID, upstream = 'http://127.0.0.1:4096'] = process.argv.slice(2)
const proxy = createV2Proxy({
  upstream,
  bridge: { beforePrompt: async () => {}, beforeInterrupt: () => {} },
  sessionID
})
proxy.listen(Number(port), '127.0.0.1', () => console.log('V2 proxy listening'))
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { proxy.closeAllConnections(); proxy.close() })
