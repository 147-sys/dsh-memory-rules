// Smoke test: import the package entry exactly as the DSH profile loader does,
// resolve through package.json "exports", and confirm the plugin surface.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const pkgDir = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))

console.log('package name     :', pkg.name)
console.log('package version  :', pkg.version)
console.log('type             :', pkg.type)
console.log('main             :', pkg.main)
console.log('exports["."]     :', pkg.exports['.'])
console.log('dsh.bundle.patch :', pkg.dsh?.bundle?.patch)

// 1. The manifest must point at real files.
assert.ok(fs.existsSync(path.join(pkgDir, pkg.main)), 'main entry must exist')
const patchPath = pkg.dsh?.bundle?.patch
assert.ok(patchPath, 'dsh.bundle.patch must be declared')
assert.ok(fs.existsSync(path.join(pkgDir, patchPath)), 'bundle patch must exist')

// 2. The bundle patch must insert a row naming this package.
const patchText = fs.readFileSync(path.join(pkgDir, patchPath), 'utf8')
assert.match(patchText, /- insert:/, 'patch must insert a row')
assert.ok(patchText.includes(`name: ${pkg.name}`), 'patch row must name the package')

// 3. The entry must load and expose the Cordis plugin surface.
const mod = await import(new URL(`file://${path.join(pkgDir, pkg.main).replace(/\\/g, '/')}`))
assert.equal(typeof mod.apply, 'function', 'apply must be exported')
assert.equal(typeof mod.name, 'string', 'name must be exported')
assert.ok(Array.isArray(mod.inject), 'inject must be an array')
console.log('plugin name      :', mod.name)
console.log('plugin inject    :', JSON.stringify(mod.inject))

// 4. Every tool the spec names must be exported through the entry point.
const EXPECTED_TOOLS = [
  'memory_write',
  'memory_search',
  'memory_retrieve',
  'memory_answer',
  'memory_reflect',
  'memory_export',
  'memory_relate'
]
assert.ok(Array.isArray(mod.ALL_TOOL_NAMES), 'ALL_TOOL_NAMES must be exported')
for (const tool of EXPECTED_TOOLS) {
  assert.ok(mod.ALL_TOOL_NAMES.includes(tool), `missing tool: ${tool}`)
}
console.log('tools            :', mod.ALL_TOOL_NAMES.join(', '))

// 5. The four memory layers must be reachable through the entry point.
for (const symbol of ['openMemoryService', 'retrieve', 'reflect', 'resolveConfig', 'buildRecallBlock']) {
  assert.equal(typeof mod[symbol], 'function', `${symbol} must be exported`)
}

// 6. The plugin must not depend on any @deepseek-ai package at import time.
const sourceFiles = fs
  .readdirSync(path.join(pkgDir, 'lib'))
  .filter((n) => n.endsWith('.js'))
for (const file of sourceFiles) {
  const text = fs.readFileSync(path.join(pkgDir, 'lib', file), 'utf8')
  const bad = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((s) => !s.startsWith('.'))
  for (const spec of bad) {
    assert.ok(spec.startsWith('node:'), `lib/${file} imports non-builtin "${spec}"`)
  }
}
console.log('import audit     : only relative + node: builtins')

console.log('\nSMOKE TEST PASSED')
