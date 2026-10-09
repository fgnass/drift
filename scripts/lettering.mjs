// Turns the wordmark into inline SVG at build time (same approach as in begone).
//
// Elements in index.html with `data-lettering` get the glyph outlines of
// their text in Economica Italic. So the page needs no web font: no extra
// request and no flash of the fallback font. To change a text, edit it in
// index.html.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import * as hb from "harfbuzzjs";

const require = createRequire(import.meta.url);
const FONT =
  require.resolve("@fontsource/economica/files/economica-latin-400-italic.woff");

/** Unpacks a WOFF 1.0 file into a plain sfnt, which HarfBuzz can read. */
function woffToSfnt(woff) {
  const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (v.getUint32(0) !== 0x774f4646) throw new Error("Not a WOFF file");
  const n = v.getUint16(12);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const e = 44 + i * 20;
    const offset = v.getUint32(e + 4);
    const compLength = v.getUint32(e + 8);
    const origLength = v.getUint32(e + 12);
    const raw = woff.subarray(offset, offset + compLength);
    tables.push({
      tag: v.getUint32(e),
      checksum: v.getUint32(e + 16),
      data: compLength < origLength ? new Uint8Array(inflateSync(raw)) : raw,
    });
  }
  let size = 12 + n * 16;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  const pow = 2 ** Math.floor(Math.log2(n));
  o.setUint32(0, v.getUint32(4)); // flavor
  o.setUint16(4, n);
  o.setUint16(6, pow * 16);
  o.setUint16(8, Math.log2(pow));
  o.setUint16(10, n * 16 - pow * 16);
  let pos = 12 + n * 16;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    o.setUint32(r, t.tag);
    o.setUint32(r + 4, t.checksum);
    o.setUint32(r + 8, pos);
    o.setUint32(r + 12, t.data.length);
    out.set(t.data, pos);
    pos += (t.data.length + 3) & ~3;
  });
  return out;
}

const font = new hb.Font(
  new hb.Face(new hb.Blob(woffToSfnt(readFileSync(FONT)).buffer)),
);

/** SVG of `text`, shaped like a browser would. CSS font-size sets its size. */
export function lettering(text) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();

  // Put all glyphs into one path. Glyph outlines are y-up, SVG is y-down.
  // The box is tight around the ink, so the CSS can place the wordmark exactly.
  let pen = 0;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  let d = "";
  for (const [i, glyph] of infos.entries()) {
    const p = positions[i];
    const dx = pen + p.xOffset;
    const dy = -p.yOffset;
    d += font
      .glyphToPath(glyph.codepoint)
      .replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => {
        const px = Math.round(Number(x) + dx);
        const py = Math.round(dy - Number(y));
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        return `${px} ${py}`;
      });
    pen += p.xAdvance;
  }

  const height = maxY - minY;
  return (
    `<svg class="lettering" viewBox="${minX} ${minY} ${maxX - minX} ${height}" ` +
    `style="height:${(height / font.face.upem).toFixed(3)}em" role="img" aria-label="${text}">` +
    `<path fill="currentColor" d="${d}"/></svg>`
  );
}

/** Replaces the text of every element with `data-lettering` in index.html. */
export function letteringPlugin() {
  return {
    name: "lettering",
    transformIndexHtml(html) {
      return html.replace(
        /(<(\w+)[^>]*\sdata-lettering[^>]*>)([^<]*)(<\/\2>)/g,
        (_, open, _tag, text, close) => open + lettering(text.trim()) + close,
      );
    },
  };
}
