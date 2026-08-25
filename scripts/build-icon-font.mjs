// Builds resources/dsh-icon.woff — the status bar icon font.
//
// Derived from resources/icon.svg (itself derived from Noto Emoji's 🐳,
// Apache-2.0; see NOTICE): one silhouette glyph plus two splash animation
// frames (the splash shrinks/grows), which the status bar alternates while
// starting/installing so the whale's spout appears to pulse.
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

/** Turn every shape of the icon into one flat silhouette. */
const silhouette = (svg) => svg.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#000000"')

// The splash is the light-blue shapes (#7FA3FF) in icon.svg: the spout path
// plus the five drops. Wrap them in a scale group for the two animation frames.
const splashRegex = /(<path[^>]*fill="#7FA3FF"[^>]*\/>(?:\s*<ellipse[^>]*fill="#7FA3FF"[^>]*\/>)*)/
const splash = icon.match(splashRegex)?.[1]
if (!splash) throw new Error('splash shapes not found in resources/icon.svg')

const flatSplash = splash.replace(/fill="#7FA3FF"/g, 'fill="#000000"')
const frame = (scale) =>
  silhouette(icon).replace(
    flatSplash,
    `<g fill="#000000" transform="translate(56 27) scale(${scale}) translate(-56 -27)">${flatSplash.replace(/fill="#000000"/g, '')}</g>`,
  )

const glyphs = [
  { name: 'dsh-whale', unicode: '\uE900', body: silhouette(icon) },
  { name: 'dsh-whale-splash-small', unicode: '\uE901', body: frame(0.78) },
  { name: 'dsh-whale-splash-large', unicode: '\uE902', body: frame(1.25) },
]

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`

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
