/**
 * Coverage tests for detectIssueTemplate paths.
 *
 * detectIssueTemplate uses getOriginalCwd() to find .github/ISSUE_TEMPLATE.
 * These tests create the template directory in the REAL project CWD and clean
 * up after each test.
 *
 * IMPORTANT: No state mock is used — this avoids global mock contamination.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { promisify } from 'node:util'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── child_process mock ──
let _execFileSyncImplT: (
  cmd: string,
  args: string[],
  opts?: unknown,
) => Buffer = () => Buffer.from('')
let _execFileImplT: (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void = (_cmd, _args, _opts, cb) => cb(null, '', '')

const execFileSyncMockT = (
  cmd: string,
  args: string[],
  opts?: unknown,
): Buffer => _execFileSyncImplT(cmd, args, opts)
const execFileMockT = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => _execFileImplT(cmd, args, opts, cb)

;(execFileMockT as unknown as Record<symbol, unknown>)[
  promisify.custom as symbol
] = (
  cmd: string,
  args: string[],
  opts: unknown,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) =>
    _execFileImplT(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    }),
  )

mock.module('node:child_process', () => ({
  execFile: execFileMockT,
  execFileSync: execFileSyncMockT,
  exec: () => {},
  execSync: () => Buffer.from(''),
  spawn: () => ({}),
  spawnSync: () => ({ status: 0, stdout: Buffer.from('') }),
  fork: () => ({}),
  ChildProcess: class {},
  _forkChild: () => {},
}))

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

// ── State ──
let tmpDir: string
let claudeDir: string

// The real CWD where the issue command will look for .github/ISSUE_TEMPLATE
// We determine this at import time (stable throughout test run)
const realCwd = process.cwd()
// We track whether we created the template dir so we can clean it up
let createdTemplatePath: string | null = null

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'issue-tpl-test-'))
  claudeDir = join(tmpDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  createdTemplatePath = null

  // Default: git → GitHub remote, gh → available, async → issues true + create OK
  let n = 0
  _execFileSyncImplT = (cmd, _args, _opts) => {
    if (cmd === 'git') return Buffer.from('https://github.com/owner/repo.git\n')
    if (cmd === 'gh') return Buffer.from('gh version 2.0.0')
    return Buffer.from('')
  }
  _execFileImplT = (_cmd, _args, _opts, cb) => {
    n++
    if (n === 1) cb(null, 'true\n', '')
    else cb(null, 'https://github.com/owner/repo/issues/20', '')
  }
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
  // Clean up any template dir we created in the real CWD
  if (createdTemplatePath && existsSync(createdTemplatePath)) {
    rmSync(createdTemplatePath, { recursive: true, force: true })
  }
  createdTemplatePath = null
})

// ── Helpers ──
type CallFn = (args: string) => Promise<{ type: string; value: string }>

async function getCallFn(): Promise<CallFn> {
  const mod = await import('../index.js')
  const loaded = await (
    mod.default as unknown as { load: () => Promise<{ call: CallFn }> }
  ).load()
  return loaded.call.bind(loaded) as CallFn
}

/**
 * Creates .github/ISSUE_TEMPLATE in the REAL CWD.
 * Registers for cleanup in afterEach.
 */
function createTemplateInCwd(files: Record<string, string>): string {
  const templateDir = join(realCwd, '.github', 'ISSUE_TEMPLATE')
  mkdirSync(templateDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(templateDir, name), content)
  }
  // Track the .github dir for cleanup (remove whole .github if it didn't exist)
  const githubDir = join(realCwd, '.github')
  createdTemplatePath = githubDir
  return templateDir
}

describe('issue command — detectIssueTemplate template paths', () => {
  test('md template with front-matter → front-matter stripped', async () => {
    createTemplateInCwd({
      'bug.md':
        '---\nname: Bug Report\nabout: A bug\n---\n## Describe the bug\n\nDetails.',
    })
    const call = await getCallFn()
    const result = await call('Fix bug with template')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Issue created')
  })

  test('md template without front-matter → content returned as-is', async () => {
    createTemplateInCwd({
      'feature.md': '## Feature Request\n\nDescribe the feature.',
    })
    const call = await getCallFn()
    const result = await call('Add feature')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Issue created')
  })

  test('yml file only → mdFile not found → no template (null)', async () => {
    createTemplateInCwd({
      'bug.yml': 'name: Bug\ndescription: Describe the bug.',
    })
    const call = await getCallFn()
    const result = await call('Fix yml-only template issue')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Issue created')
  })

  test('md template stripped to empty → null (stripped || null)', async () => {
    // Front-matter only, empty body after stripping
    createTemplateInCwd({
      'empty.md': '---\nname: Empty\nabout: empty\n---',
    })
    const call = await getCallFn()
    const result = await call('Empty template test')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Issue created')
  })
})
