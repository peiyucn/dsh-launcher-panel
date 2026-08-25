// Builds resources/dsh-icon.woff — the status bar icon font.
//
// resources/icon.svg is the single source of the whale artwork: a silhouette
// with the eye and the belly line punched as counter-wound sub-paths (holes
// under nonzero winding). This script turns it into one glyph plus two splash
// animation frames (the spout shrinks/grows), which the status bar alternates
// while starting/installing so the whale's spout pulses.
//
// Run: npm run build:icon-font
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont'
import svg2ttf from 'svg2ttf'
import ttf2woff from 'ttf2woff'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const icon = readFileSync(join(root, 'resources', 'icon.svg'), 'utf8')

// Path order in resources/icon.svg: merged body (with punched eye + belly
// holes), tail, spout, spout.
const ds = [...icon.matchAll(/<path[^>]*d="([^"]+)"/g)].map((m) => m[1])
if (ds.length < 4) throw new Error('unexpected icon.svg structure — expected 4 paths')

const path = (d) => `<path fill="#000000" d="${d}"/>`
const silhouette = ds.map((d) => path(d)).join('')

// The spout (last two paths) is wrapped in a scale group for the frames.
const spout = path(ds[2]) + path(ds[3])
const frame = (scale) =>
  silhouette.replace(
    spout,
    `<g transform="translate(8 6) scale(${scale}) translate(-8 -6)">${spout}</g>`,
  )

const glyphs = [
  { name: 'dsh-whale', unicode: '\uE900', body: silhouette },
  { name: 'dsh-whale-splash-small', unicode: '\uE901', body: frame(0.8) },
  { name: 'dsh-whale-splash-large', unicode: '\uE902', body: frame(1.25) },
]

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">${body}</svg>`

const fontStream = new SVGIcons2SVGFontStream({ fontName: 'dsh-icon', normalize: true, fontHeight: 1000 })
let svgFont = ''
fontStream.on('data', (chunk) => { svgFont += chunk.toString() })
const done = new Promise((resolve, reject) => {
  fontStream.on('end', resolve)
  fontStream.on('error', reject)
})
for (const g of glyphs) {
  const glyphStream = Readable.from([svg(g.body)])
  glyphStream.metadata = { unicode: [g.unicode], name: g.name }
  fontStream.write(glyphStream)
}
fontStream.end()
await done

const ttf = svg2ttf(svgFont, {})
const woff = ttf2woff(ttf.buffer)
const outFile = join(root, 'resources', 'dsh-icon.woff')
writeFileSync(outFile, woff)
console.log(`wrote ${outFile} (${woff.length} bytes, glyphs: ${glyphs.map((g) => g.name).join(', ')})`)
