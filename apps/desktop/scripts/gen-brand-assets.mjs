// 品牌资产可重复生成脚本。
// 单一矢量源位于 apps/desktop/brand/*.svg（手工重建的矢量标识，AI 图仅作母稿，未嵌入 PNG）。
// 本脚本读取 brand/icon.svg（容器版主标识）栅格化为 build/ 下的 PNG/ICNS/ICO 与 Linux 尺寸集。
//
// 栅格后端（按可用性回退，保证可重复）：
//   1) @resvg/resvg-js（跨平台，若已安装）
//   2) macOS Quick Look `qlmanage` + `sips`（本机发布环境，无需额外依赖）
// ICNS 用 macOS `iconutil` 由 iconset 合成；ICO 用纯 Node 以 PNG 条目写出（跨平台）。
// 产物（build/*.png|icns|ico 与 build/icons/**）应提交入库，CI/运行时无需光栅器。
//
// 用法：node apps/desktop/scripts/gen-brand-assets.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(__dirname, '..');
const BRAND = join(DESKTOP, 'brand');
const BUILD = join(DESKTOP, 'build');
const ICONS = join(BUILD, 'icons');
const LINUX = join(ICONS, 'linux');

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// ---- 标识几何（viewBox 0 0 64 64）：右侧半圆 = 连续流转环；左侧尖角 = 代码括号「<」；四节点 = 智能节点。 ----
const VB = 64;
const LOOP_D = 'M32 15 A17 17 0 0 1 32 49 L13 32 L32 15 Z';
const NODES = [
  { x: 32, y: 15 }, // 顶
  { x: 49, y: 32 }, // 右
  { x: 32, y: 49 }, // 底
  { x: 13, y: 32 }, // 左（括号顶点）
];
const STROKE_W = 8;
const NODE_R = 6;

// 调色板：电光蓝 / 青色为主，紫罗兰为克制点缀。
const C = {
  electric: '#2f6bff',
  cyan: '#22d3ee',
  blue: '#1d4ed8',
  violet: '#7c5cff',
  lightCyan: '#67e8f9',
  white: '#ffffff',
};

const loopGradientDef = (id) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="${C.electric}"/><stop offset="1" stop-color="${C.cyan}"/></linearGradient>`;

/** 标识主体（环 + 四节点）。stroke 为环颜色/引用，nodes 为长度 4 的填色数组。 */
function markInner(stroke, nodes) {
  const path =
    `<path d="${LOOP_D}" fill="none" stroke="${stroke}" stroke-width="${STROKE_W}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>`;
  const dots = NODES.map((n, i) => `<circle cx="${n.x}" cy="${n.y}" r="${NODE_R}" fill="${nodes[i]}"/>`).join('');
  return path + dots;
}

const colorNodes = [C.blue, C.cyan, C.electric, C.violet];
const containerNodes = [C.white, C.lightCyan, C.white, C.lightCyan];
const darkNodes = [C.electric, C.cyan, C.electric, C.violet];

function svg(width, height, viewBox, defs, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" ` +
    `role="img" aria-label="ai-devflow">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`
  );
}

// 1) 容器版（应用图标主源）：品牌渐变圆角方底 + 白色标识，深浅底皆高对比、16px 清晰。
const containerDefs =
  loopGradientDef('cg') +
  `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#1e3a8a"/><stop offset="0.55" stop-color="#2563eb"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>`;
const containerBody =
  `<rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bg)"/>` + markInner(C.white, containerNodes);
// 容器版主源固有尺寸设为 1024（viewBox 仍 64）：qlmanage 按 CSS 像素 1:1 渲染并填满画布，
// 否则矢量源的小固有尺寸会被光栅器当成缩略图源而留白，导致小尺寸栅格糊在角落。
const ICON_SVG = svg(1024, 1024, `0 0 ${VB} ${VB}`, containerDefs, containerBody);

// 2) 独立标识（透明底，彩色，侧边栏/浅色界面内联用）。
const MARK_SVG = svg(VB, VB, `0 0 ${VB} ${VB}`, loopGradientDef('mg'), markInner('url(#mg)', colorNodes));

// 3) 单色标识（currentColor，随主题/容器变色）。
const MONO_SVG = svg(VB, VB, `0 0 ${VB} ${VB}`, '', markInner('currentColor', ['currentColor', 'currentColor', 'currentColor', 'currentColor']));

// 4) 浅色容器版。
const lightBody =
  `<rect x="2" y="2" width="60" height="60" rx="14" fill="#eef2ff"/>` + markInner('url(#lg)', colorNodes);
const LIGHT_SVG = svg(VB, VB, `0 0 ${VB} ${VB}`, loopGradientDef('lg'), lightBody);

// 5) 深色容器版。
const darkBody =
  `<rect x="2" y="2" width="60" height="60" rx="14" fill="#0b1220"/>` + markInner('url(#dg)', darkNodes);
const DARK_SVG = svg(VB, VB, `0 0 ${VB} ${VB}`, loopGradientDef('dg'), darkBody);

// 6) 横版锁定（图标 + 文字）。
function lockup(textFill) {
  const w = 220;
  const h = 64;
  const inner =
    `<g transform="translate(2,0) scale(0.94)">${markInner('url(#lk)', colorNodes)}</g>` +
    `<text x="74" y="41" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif" ` +
    `font-size="27" font-weight="700" letter-spacing="-0.5" fill="${textFill}">ai-devflow</text>`;
  return svg(w, h, `0 0 ${w} ${h}`, loopGradientDef('lk'), inner);
}
const LOCKUP_SVG = lockup('#0b1220');
const lockupMono =
  `<g transform="translate(2,0) scale(0.94)">${markInner('currentColor', ['currentColor', 'currentColor', 'currentColor', 'currentColor'])}</g>` +
  `<text x="74" y="41" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif" ` +
  `font-size="27" font-weight="700" letter-spacing="-0.5" fill="currentColor">ai-devflow</text>`;
const LOCKUP_MONO_SVG = svg(220, 64, '0 0 220 64', '', lockupMono);

// ---- 写出单一矢量源 ----
mkdirSync(BRAND, { recursive: true });
writeFileSync(join(BRAND, 'icon.svg'), ICON_SVG);        // 容器版（栅格主源）
writeFileSync(join(BRAND, 'mark.svg'), MARK_SVG);        // 独立标识（透明彩色）
writeFileSync(join(BRAND, 'mark-mono.svg'), MONO_SVG);   // 单色
writeFileSync(join(BRAND, 'light.svg'), LIGHT_SVG);      // 浅底容器
writeFileSync(join(BRAND, 'dark.svg'), DARK_SVG);        // 深底容器
writeFileSync(join(BRAND, 'lockup.svg'), LOCKUP_SVG);    // 图标 + 文字（彩色）
writeFileSync(join(BRAND, 'lockup-mono.svg'), svg(220, 64, '0 0 220 64', '', lockupMono)); // 图标 + 文字（单色）
console.log('[brand] wrote SVG sources ->', BRAND);

// ---- 栅格化后端 ----
let rasterize; // (svgPath, size) => Buffer(png)
try {
  const { Resvg } = await import('@resvg/resvg-js');
  rasterize = (svgPath, size) => {
    const r = new Resvg(readFileSync(svgPath, 'utf8'), {
      fitTo: { mode: 'width', value: size },
      background: 'rgba(0,0,0,0)',
    });
    return Buffer.from(r.render().asPng());
  };
  console.log('[brand] raster backend: @resvg/resvg-js');
} catch {
  // 回退 macOS Quick Look：qlmanage 仅渲染 1024 母图，其余尺寸一律用 sips 从母图重采样重编码。
  // （qlmanage 直出 PNG 的色彩空间/编码会被 iconutil 判为 “Invalid Iconset”，sips 重编码后即为标准 8-bit PNG。）
  const masterCache = new Map();
  const ensureMaster = (svgPath) => {
    if (masterCache.has(svgPath)) return masterCache.get(svgPath);
    const out = join(BUILD, '.ql-tmp');
    mkdirSync(out, { recursive: true });
    const r = spawnSync('qlmanage', ['-t', '-s', '1024', '-o', out, svgPath], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('qlmanage failed for ' + svgPath);
    const produced = readdirSync(out).find((f) => f.endsWith('.png'));
    if (!produced) throw new Error('qlmanage produced no png');
    const master = join(out, produced);
    masterCache.set(svgPath, master);
    return master;
  };
  rasterize = (svgPath, size) => {
    const master = ensureMaster(svgPath);
    const tmp = join(BUILD, '.ql-tmp', `sized-${size}.png`);
    const r = spawnSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), master, '--out', tmp], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('sips resize failed for ' + size);
    return readFileSync(tmp);
  };
  console.log('[brand] raster backend: macOS qlmanage + sips');
}

mkdirSync(ICONS, { recursive: true });
mkdirSync(LINUX, { recursive: true });
const containerSvg = join(BRAND, 'icon.svg');

// 1024 容器主图（electron-builder 默认 icon.png / win / linux 源）
writeFileSync(join(BUILD, 'icon.png'), rasterize(containerSvg, 1024));

// 尺寸集
for (const s of SIZES) {
  writeFileSync(join(ICONS, `${s}.png`), rasterize(containerSvg, s));
}
for (const s of LINUX_SIZES) {
  writeFileSync(join(LINUX, `${s}.png`), rasterize(containerSvg, s));
}
console.log('[brand] wrote PNG set ->', ICONS, '+ linux');

// ---- ICNS（纯 Node：以 PNG 封装 icp4..ic10 元素，跨平台，不依赖 iconutil）----
// Apple Icon Services 的 PNG 压缩 OSType 与像素尺寸对应。
function writeIcns(pngBySize) {
  const typeFor = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const elements = [];
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    const png = pngBySize[size];
    if (!png) continue;
    const type = Buffer.from(typeFor[size], 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(8 + png.length, 0);
    elements.push(Buffer.concat([type, len, png]));
  }
  const total = Buffer.alloc(8);
  total.write('icns', 0, 'ascii');
  total.writeUInt32BE(8 + elements.reduce((a, e) => a + e.length, 0), 4);
  return Buffer.concat([total, ...elements]);
}
writeFileSync(join(BUILD, 'icon.icns'), writeIcns(Object.fromEntries(SIZES.map((s) => [s, readFileSync(join(ICONS, `${s}.png`))]))));
console.log('[brand] wrote ICNS (pure-node PNG elements) ->', join(BUILD, 'icon.icns'));

// ---- ICO（纯 Node：以 PNG 条目封装，跨平台）----
function writeIco(pngBuffers) {
  const n = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = ICO
  header.writeUInt16LE(n, 4);      // count
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  pngBuffers.forEach((png, i) => {
    // 读 PNG 尺寸（IHDR 在偏移 16，宽高各 4 字节大端）
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    const o = i * 16;
    dir.writeUInt8(w >= 256 ? 0 : w, o + 0);     // width (0 = 256)
    dir.writeUInt8(h >= 256 ? 0 : h, o + 1);     // height
    dir.writeUInt8(0, o + 2);                    // color palette
    dir.writeUInt8(0, o + 3);                    // reserved
    dir.writeUInt16LE(1, o + 4);                 // color planes
    dir.writeUInt16LE(32, o + 6);                // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);        // bytes in res
    dir.writeUInt32LE(offset, o + 12);           // offset
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngBuffers]);
}
const pngFor = (s) => readFileSync(existsSync(join(ICONS, `${s}.png`)) ? join(ICONS, `${s}.png`) : join(LINUX, `${s}.png`));
const icoBufs = ICO_SIZES.map((s) => pngFor(s));
writeFileSync(join(BUILD, 'icon.ico'), writeIco(icoBufs));
console.log('[brand] wrote ICO (pure-node PNG entries) ->', join(BUILD, 'icon.ico'));

// 清理 qlmanage 临时目录
rmSync(join(BUILD, '.ql-tmp'), { recursive: true, force: true });
console.log('[brand] done.');
