#!/usr/bin/env node
/**
 * Fake Copilot Upstream Server for Integration Testing
 * 
 * Simulates the Copilot API for testing without real model calls:
 * - POST /auto - returns session token and model selection
 * - POST /responses - returns streaming SSE response
 * - POST /chat/completions - returns chat response
 * - GET /models - returns model catalog
 * 
 * Validates credentials and tracks requests for assertions.
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

export function createFakeCopilotUpstream({ 
  validCredentials = new Set(),
  donorFailures = new Map(),  // credential -> { status, after }
  responseDelay = 0,
  log = console.error
}) {
  const requests = []
  let sessionTokens = new Map()  // sessionToken -> { model, credential, expires }
  let server = null
  let port = 0
  
  function validateCredential(req) {
    const auth = req.headers.authorization || ''
    const credential = auth.replace(/^Bearer /i, '')
    if (!credential || !validCredentials.has(credential)) {
      return { valid: false, status: 401 }
    }
    
    // Check if this credential should fail (donor failure simulation)
    const failure = donorFailures.get(credential)
    if (failure && (!failure.after || requests.length >= failure.after)) {
      return { valid: false, status: failure.status, credential }
    }
    
    return { valid: true, credential }
  }
  
  async function handleRequest(req, res) {
    const requestId = randomBytes(8).toString('hex')
    let body = ''
    
    for await (const chunk of req) {
      body += chunk
    }
    
    const request = {
      id: requestId,
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: body ? JSON.parse(body) : null,
      timestamp: Date.now()
    }
    requests.push(request)
    
    log(`[fake-upstream] ${requestId} ${req.method} ${req.url}`)
    
    const authResult = validateCredential(req)
    if (!authResult.valid) {
      res.writeHead(authResult.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Unauthorized', code: 'auth_error' } }))
      log(`[fake-upstream] ${requestId} rejected: ${authResult.status}`)
      return
    }
    
    const path = req.url.split('?')[0]
    
    if (responseDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, responseDelay))
    }
    
    try {
      if (path === '/auto' && req.method === 'POST') {
        await handleAuto(req, res, request, authResult)
      } else if (path === '/responses' && req.method === 'POST') {
        await handleResponses(req, res, request, authResult)
      } else if (path === '/chat/completions' && req.method === 'POST') {
        await handleChatCompletions(req, res, request, authResult)
      } else if (path === '/models' && req.method === 'GET') {
        await handleModels(req, res, request)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    } catch (error) {
      log(`[fake-upstream] ${requestId} error: ${error.message}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal error' }))
      }
    }
  }
  
  async function handleAuto(req, res, request, authResult) {
    const { tier } = request.body || {}
    
    const sessionToken = `ses_${randomBytes(16).toString('hex')}`
    const model = tier === 'premium' ? 'claude-sonnet-4' : 'gpt-4.1'
    const expires = Math.floor((Date.now() + 300000) / 1000)
    
    sessionTokens.set(sessionToken, {
      model,
      credential: authResult.credential,
      expires: expires * 1000
    })
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      session_token: sessionToken,
      selected_model: {
        id: model,
        supported_endpoints: ['/responses', '/chat/completions'],
        vision: false,
        capabilities: { limits: { max_output_tokens: 16000 } }
      },
      expires_at: expires,
      fallback: false
    }))
  }
  
  async function handleResponses(req, res, request, authResult) {
    const sessionToken = req.headers['copilot-session-token']
    const session = sessionTokens.get(sessionToken)
    
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid session', code: 'invalid_session' } }))
      return
    }
    
    const stream = request.body?.stream !== false
    
    if (stream) {
      res.writeHead(200, { 
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      
      // Simulate streaming response
      const responseId = `resp_${randomBytes(8).toString('hex')}`
      
      // Content start
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: responseId, model: session.model } })}\n\n`)
      
      // Output item
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'message', role: 'assistant' } })}\n\n`)
      
      // Content deltas
      const text = 'This is a test response from the fake upstream.'
      for (const char of text) {
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: char })}\n\n`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Done
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.done', text })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.done' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.done', response: { id: responseId, status: 'completed' } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `resp_${randomBytes(8).toString('hex')}`,
        model: session.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Test response.' }] }],
        status: 'completed'
      }))
    }
  }
  
  async function handleChatCompletions(req, res, request, authResult) {
    const sessionToken = req.headers['copilot-session-token']
    const session = sessionTokens.get(sessionToken)
    
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid session', code: 'invalid_session' } }))
      return
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: `chatcmpl_${randomBytes(8).toString('hex')}`,
      model: session.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Test chat completion response.' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }))
  }
  
  async function handleModels(req, res, request) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'gpt-4.1', owned_by: 'openai' },
        { id: 'claude-sonnet-4', owned_by: 'anthropic' }
      ]
    }))
  }
  
  async function start() {
    server = createServer(handleRequest)
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port
        log(`[fake-upstream] Listening on 127.0.0.1:${port}`)
        resolve()
      })
      server.once('error', reject)
    })
    return { port }
  }
  
  async function stop() {
    if (server) {
      await new Promise(resolve => server.close(resolve))
      server = null
    }
  }
  
  return {
    start,
    stop,
    getPort: () => port,
    getRequests: () => [...requests],
    clearRequests: () => { requests.length = 0 },
    addCredential: cred => validCredentials.add(cred),
    removeCredential: cred => validCredentials.delete(cred),
    setDonorFailure: (cred, status, after) => donorFailures.set(cred, { status, after }),
    clearDonorFailures: () => donorFailures.clear(),
    getSessionTokens: () => new Map(sessionTokens)
  }
}

// CLI
if (process.argv[1]?.endsWith('fake-copilot-upstream.mjs')) {
  const upstream = createFakeCopilotUpstream({
    validCredentials: new Set(['test-credential']),
    log: console.log
  })
  
  upstream.start().then(({ port }) => {
    console.log(`Fake Copilot upstream running on http://127.0.0.1:${port}`)
    console.log('Valid credential: test-credential')
  })
  
  process.on('SIGINT', () => upstream.stop().then(() => process.exit(0)))
  process.on('SIGTERM', () => upstream.stop().then(() => process.exit(0)))
}
