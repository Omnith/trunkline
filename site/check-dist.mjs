// build gate: internal links resolve, no disallowed external origins (AC1)
import fs from 'node:fs'
import path from 'node:path'

const files = []
;(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    fs.statSync(p).isDirectory() ? walk(p) : files.push(p)
  }
})('dist')

const htmls = files.filter((f) => f.endsWith('.html'))
const emitted = new Set(files.map((f) => path.relative('dist', f).split(path.sep).join('/')))
const allowedHosts = ['github.com', 'www.npmjs.com', 'trunkline.omnith.com']
const bad = []
const ext = []

for (const h of htmls) {
  const s = fs.readFileSync(h, 'utf8')
  for (const m of s.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const u = m[1]
    if (u.startsWith('data:') || u.startsWith('#')) continue
    if (/^https?:\/\//.test(u)) {
      if (!allowedHosts.includes(new URL(u).host)) ext.push(`${h} -> ${u}`)
      continue
    }
    let t = u.split('#')[0].split('?')[0].replace(/^\//, '')
    if (t === '') t = 'index.html'
    else if (t.endsWith('/')) t += 'index.html'
    else if (!/\.[a-z0-9]+$/i.test(t)) t += '/index.html'
    if (!emitted.has(t)) bad.push(`${h} -> ${u}`)
  }
}
for (const c of files.filter((f) => f.endsWith('.css'))) {
  if (/https?:\/\//.test(fs.readFileSync(c, 'utf8'))) ext.push(`CSS ${c}`)
}

console.log(`html: ${htmls.length} | broken internal: ${bad.length} | disallowed external: ${ext.length}`)
bad.forEach((b) => console.log('BROKEN', b))
ext.forEach((e) => console.log('EXTERNAL', e))
process.exit(bad.length || ext.length ? 1 : 0)
