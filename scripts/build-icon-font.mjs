// Builds resources/dsh-icon.woff — the status bar icon font.
//
// Derived from the Twemoji spouting whale artwork in resources/icon.svg
// (recolored to the brand palette): one silhouette glyph plus two splash
// animation frames (the spout shrinks/grows), which the status bar alternates
// while starting/installing so the whale's spout pulses.
//
// The silhouette keeps the eye and the belly line as counter-wound sub-paths
// merged into the body path (holes under nonzero winding), so the details
// survive in the single-color glyph.
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

// Path order in icon.svg (Twemoji whale, brand colors): body, belly band,
// tail, spout, spout. The eye is a <circle>.
const ds = [...icon.matchAll(/<path[^>]*d="([^"]+)"/g)].map((m) => m[1])
if (ds.length < 5) throw new Error('unexpected icon.svg structure — expected 5 paths')

// Counter-wound details (holes under nonzero winding): the eye hole at the
// icon's eye position, and the belly band reversed (= the belly line).
const EYE_HOLE = 'M5 25.5a1.5 1.5 0 0 0 3 0a1.5 1.5 0 0 0 -3 0Z'
const BELLY_HOLE = 'M6.5 30.8C11 33 17 33.6 22 33.1C17 32.3 11 31.7 6.5 30.8Z'

const path = (d) => `<path fill="#000000" d="${d}"/>`
// Body, eye hole and belly hole live in ONE path so nonzero winding applies.
const silhouette = path(ds[0] + EYE_HOLE + BELLY_HOLE) + path(ds[2]) + path(ds[3]) + path(ds[4])

// The spout (last two paths) is wrapped in a scale group for the frames.
const spout = path(ds[3]) + path(ds[4])
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