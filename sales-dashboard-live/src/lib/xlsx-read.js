// Minimal, dependency-free .xlsx READER (browser-only). An .xlsx is a ZIP of XML parts; this reads the central
// directory, inflates the parts it needs with the browser-native DecompressionStream (deflate-raw) -- no library --
// and returns the FIRST worksheet as string[][] (header first), the same shape the CSV parser produces so both feed
// one validator. It handles shared strings, inline strings, and numbers. Any structural problem throws a clear error.
//
// This complements src/lib/xlsx.js (the hand-rolled WRITER); together they keep .xlsx support dependency-free.

const td = new TextDecoder("utf-8");

function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }

// Locate + parse the End Of Central Directory record, then walk the central directory into a map of
// { name -> { method, compSize, localOffset } }.
function readCentralDirectory(buf) {
  const dv = new DataView(buf);
  const n = buf.byteLength;
  // EOCD signature 0x06054b50, scanned from the end (comment may follow, so search back up to 64KB).
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 65536); i -= 1) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no ZIP end record).");
  const count = u16(dv, eocd + 10);
  let off = u32(dv, eocd + 16);
  const entries = new Map();
  for (let e = 0; e < count; e += 1) {
    if (u32(dv, off) !== 0x02014b50) break;
    const method = u16(dv, off + 10);
    const compSize = u32(dv, off + 20);
    const nameLen = u16(dv, off + 28);
    const extraLen = u16(dv, off + 30);
    const commentLen = u16(dv, off + 32);
    const localOffset = u32(dv, off + 42);
    const name = td.decode(new Uint8Array(buf, off + 46, nameLen));
    entries.set(name, { method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflate(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

// Read one entry's raw bytes (following its LOCAL header to the compressed data), inflating if deflated.
async function readEntry(buf, entry) {
  const dv = new DataView(buf);
  if (u32(dv, entry.localOffset) !== 0x04034b50) throw new Error("Corrupt .xlsx (bad local header).");
  const nameLen = u16(dv, entry.localOffset + 26);
  const extraLen = u16(dv, entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const comp = new Uint8Array(buf, dataStart, entry.compSize);
  if (entry.method === 0) return td.decode(comp);
  if (entry.method === 8) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot read compressed .xlsx; please export as CSV.");
    return td.decode(await inflate(comp));
  }
  throw new Error("Unsupported .xlsx compression; please export as CSV.");
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// sharedStrings.xml -> [string]. Each <si> is one string (concatenating its <t> runs).
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(inner))) text += tm[1];
    out.push(decodeXmlEntities(text));
  }
  return out;
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// sheet xml -> string[][]. Cell text resolves shared strings (t="s"), inline strings (t="inlineStr"/"str"), else <v>.
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || "";
      const body = cm[2] || "";
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      const tM = /t="([^"]+)"/.exec(attrs);
      const type = tM ? tM[1] : "n";
      let value = "";
      if (type === "s") {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? (shared[Number(vM[1])] ?? "") : "";
      } else if (type === "inlineStr") {
        let t = "";
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let tm;
        while ((tm = tRe.exec(body))) t += tm[1];
        value = decodeXmlEntities(t);
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? decodeXmlEntities(vM[1]) : "";
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// Read the first worksheet of an .xlsx ArrayBuffer as string[][]. Throws a clear message on any problem.
export async function readXlsxFirstSheet(arrayBuffer) {
  const entries = readCentralDirectory(arrayBuffer);
  // Resolve the first sheet target via workbook rels; fall back to the lowest-numbered worksheet part.
  let sheetName = null;
  const wbRels = entries.has("xl/_rels/workbook.xml.rels") ? await readEntry(arrayBuffer, entries.get("xl/_rels/workbook.xml.rels")) : "";
  const wb = entries.has("xl/workbook.xml") ? await readEntry(arrayBuffer, entries.get("xl/workbook.xml")) : "";
  const firstSheetRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (firstSheetRid && wbRels) {
    const target = new RegExp(`<Relationship\\b[^>]*Id="${firstSheetRid}"[^>]*Target="([^"]+)"`).exec(wbRels)?.[1];
    if (target) sheetName = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  if (!sheetName || !entries.has(sheetName)) {
    const worksheets = Array.from(entries.keys()).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    sheetName = worksheets[0];
  }
  if (!sheetName) throw new Error("No worksheet found in the .xlsx file.");
  const shared = entries.has("xl/sharedStrings.xml") ? parseSharedStrings(await readEntry(arrayBuffer, entries.get("xl/sharedStrings.xml"))) : [];
  const rows = parseSheet(await readEntry(arrayBuffer, entries.get(sheetName)), shared);
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}
