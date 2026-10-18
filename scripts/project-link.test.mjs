import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import projectLinks from './project-link.cjs'

const env = { GITHUB_REPOSITORY: 'AgentsLoop/PlayGround', TRIGGER_ISSUE_NUMBER: '114' }
test('renders one canonical project access link and respects custom origins', () => {
  assert.equal(projectLinks.projectLink(env), '[Open project](https://omgithub.com/AgentsLoop/PlayGround/issues/114)')
  assert.equal(projectLinks.projectUrl({ ...env, OMGITHUB_ORIGIN: 'https://example.test/' }), 'https://example.test/AgentsLoop/PlayGround/issues/114')
})

test('comment templates render a single project access link', async () => {
  const { default: templates } = await import('../.github/scripts/opencode-comment-templates.cjs')
  for (const name of ['opencode-progress-comment-template.md', 'opencode-final-report.md']) {
    const body = templates.renderTemplate(name, { PROJECT_URL: projectLinks.projectUrl(env), SSH_SECTION: '', UPDATED: '', PROGRESS_STATS: '', ACCESS_NOTE: '', BRANCH_NAME: '', BRANCH_URL: '', RELEASE_URL: '', IMAGES: '' })
    assert.equal(body.split(projectLinks.projectUrl(env)).length - 1, 1)
    assert.doesNotMatch(body, /@(APP_URL|FILES_URL|OPENCODE_WEB_URL|PROJECT_FILE_URL|VALIDATION_SESSION_SECTION)@/)
  }
})

test('workspace and deployment comments use the canonical link helper', async () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  for (const title of ['Publish restored workspace', 'Publish restored preview', 'Post temporary access details']) {
    const block = workflow.split(`      - name: ${title}`)[1]?.split('      - name:')[0]
    assert.ok(block, title)
    assert.match(block, /projectLink\(process.env\)/)
    assert.doesNotMatch(block, /OPENCODE_WEB_URL|PROJECT_FILE_URL|APP_URL/)
  }
  const deploy = readFileSync(new URL('./session-deploy.mjs', import.meta.url), 'utf8')
  assert.match(deploy, /body=Preview ready\.[\s\S]*projectLinks.projectLink\(env\)/)
  assert.match(deploy, /const report = .*projectLinks.projectLink\(env\)/)
})
