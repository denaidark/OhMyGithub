export function parseIssueRequest(issue, defaultBranch = 'main') {
  const body = String(issue?.body || '')
  const title = String(issue?.title || '').trim()
  let metadata = {}
  try { metadata = JSON.parse(body.match(/<!-- omgithub-request:v1 (\{[^\n]*\}) -->/)?.[1] || '{}') } catch {}
  const requestBody = body.replace(/<!-- omgithub-request:v1 \{[^\n]*\} -->/g, '').trim()
  const requestTitle = title
  const modelChain = parseModelChain(metadata.model_chain)
  if (typeof metadata.branch !== 'string') return { request: requestBody || title, title, targetRef: defaultBranch, branchSpecified: false, branchError: '', modelChain }
  const targetRef = metadata.branch.trim()
  const invalid = !targetRef || targetRef.length > 255 || targetRef === '@' || targetRef.startsWith('-') ||
    targetRef.startsWith('/') || targetRef.endsWith('/') || targetRef.endsWith('.') || targetRef.endsWith('.lock') ||
    targetRef.includes('..') || targetRef.includes('@{') || targetRef.includes('//') ||
    targetRef.split('/').some(part => part.startsWith('.')) || /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(targetRef)
  return {
    request: requestBody || requestTitle,
    title: requestTitle,
    targetRef: invalid ? defaultBranch : targetRef,
    branchSpecified: true,
    branchError: invalid ? 'Invalid branch metadata.' : '',
    modelChain
  }
}

const MODEL_ID_PATTERN = /^[\w.-]+\/[\w./:-]+$/
const MAX_CHAIN_LENGTH = 20

export function parseModelChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return null
  const validated = chain
    .slice(0, MAX_CHAIN_LENGTH)
    .filter(id => typeof id === 'string' && MODEL_ID_PATTERN.test(id))
  return validated.length > 0 ? validated : null
}
