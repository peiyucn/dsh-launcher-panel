// Builds resources/dsh-icon.woff — the status bar icon font.
//
// Derived from the original 🐳 artwork in resources/icon.svg: one silhouette
// glyph plus two splash animation frames (the splash shrinks/grows), which the
// status bar alternates while starting/installing so the spout pulses.
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

/** Flatten every shape (including gradient fills) into one silhouette color. */
const silhouette = (svg) =>
  svg
    .replace(/fill="url\(#[0-9A-Za-z]+\)"/g, 'fill="#000000"')
    .replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#000000"')

// The splash is the "url(#splash)" group in icon.svg (spout cloud + drops).
// Wrap it in a scale group for the two animation frames.
// The splash is the light-blue shapes in icon.svg. Two forms exist: a
// gradient group (url(#splash), newer artwork) or flat #7FA3FF shapes
// (Noto-derived artwork) — support both, so icon.svg edits keep working.
const splashUrlMatch = icon.match(/<g fill="url\(#[0-9A-Za-z]+\)">[\s\S]*?<\/g>/)
const splashFlatMatch = icon.match(/<path[^>]*fill="#7FA3FF"[^>]*\/>(?:\s*<ellipse[^>]*fill="#7FA3FF"[^>]*\/>)*/)
const splashToken = splashUrlMatch?.[0] ?? splashFlatMatch?.[0]
if (!splashToken) throw new Error('splash not found in resources/icon.svg')
const splashInner = splashToken.replace(/^<g[^>]*>/, '').replace(/<\/g>$/, '')
const [scx, scy] = splashUrlMatch ? [76, 24] : [56, 27]
// Replace the splash FIRST (while it still carries its original markup),
// then flatten to a silhouette — otherwise the match string never appears.
const frame = (scale) =>
  silhouette(
    icon.replace(
      splashToken,
      `<g transform="translate(${scx} ${scy}) scale(${scale}) translate(${-scx} ${-scy})">${splashInner}</g>`,
    ),
  )

const glyphs = [
  { name: 'dsh-whale', unicode: '\uE900', body: silhouette(icon) },
  { name: 'dsh-whale-splash-small', unicode: '\uE901', body: frame(0.8) },
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