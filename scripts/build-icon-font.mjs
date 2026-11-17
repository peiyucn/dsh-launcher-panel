import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont'
import svg2ttf from 'svg2ttf'
import ttf2woff from 'ttf2woff'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const icon = readFileSync(join(root, 'resources', 'icon.svg'), 'utf8')

const ds = [...icon.matchAll(/<path[^>]*d="([^"]+)"/g)].map((m) => m[1])
if (ds.length < 4) throw new Error('unexpected icon.svg structure — expected 4 paths')

const path = (d) => `<path fill="#000000" d="${d}"/>`
const silhouette = ds.map((d) => path(d)).join('')

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

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><g transform="translate(2.16 2.16) scale(0.88)">${body}</g></svg>`

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
