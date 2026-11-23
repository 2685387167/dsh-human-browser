/**
 * snapshot.js — 页面语义快照的表达式生成器。
 *
 * 单独成文件的两个理由：
 *  1. 它在 background.js 里是一大段字符串，写错个引号只有真浏览器才报错；
 *     抽出来就能用 `new Function` 做语法编译测试（tests/snapshot.test.mjs）。
 *  2. 它是这个插件最需要反复打磨的一段代码，独立出来改起来不心虚。
 *
 * 约定：表达式必须**纯函数式** —— 除了读 DOM，不写任何全局、不打属性、不挂监听器。
 */

const SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'textarea',
  'select',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=option]',
  '[role=switch]',
  '[role=textbox]',
  '[contenteditable=""]',
  '[contenteditable=true]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export const BUILD_ID = 'snapshot-v3'

export function snapshotExpression(max, includeOffscreen) {
  return `(() => {
  const MAX = ${Number(max) || 260};
  const OFF = ${includeOffscreen ? 'true' : 'false'};
  const SEL = ${JSON.stringify(SELECTOR)};
  const els = [], desc = [], seen = new Set();
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, 96);

  function labelOf(el) {
    const g = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const tag = el.tagName;
    const type = (g('type') || '').toLowerCase();
    const field = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    const cands = [
      g('aria-label'),
      g('placeholder'),
      (tag === 'INPUT' && (type === 'submit' || type === 'button')) ? el.value : '',
      g('title'),
      field || el.querySelector('textarea, select, [contenteditable]') ? '' : el.innerText || el.textContent,
      g('name'),
      g('alt'),
    ];
    for (const c of cands) { const s = norm(c); if (s) return s; }
    return '';
  }

  function kindOf(el) {
    const tag = el.tagName;
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (tag === 'A') return 'link';
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (type === 'checkbox' || type === 'radio') return 'toggle';
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return 'click';
      return 'type';
    }
    if (tag === 'SELECT') return 'select';
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '') return 'type';
    return 'click';
  }

  function walk(root, ox, oy, depth) {
    if (desc.length >= MAX || depth > 8) return;
    let nodes;
    try { nodes = root.querySelectorAll(SEL); } catch (e) { nodes = []; }
    const ownerDoc = root.ownerDocument || root;
    const view = (ownerDoc && ownerDoc.defaultView) || window;
    let vw = 1280, vh = 800;
    try { vw = view.innerWidth; vh = view.innerHeight; } catch (e) {}

    for (const el of nodes) {
      if (desc.length >= MAX) break;
      if (seen.has(el)) continue;
      seen.add(el);
      let cs;
      try { cs = view.getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const x = r.x + ox, y = r.y + oy;
      const inView = y + r.height > -2 && y < vh + 2 && x + r.width > -2 && x < vw + 2;
      if (!inView && !OFF) continue;
      const disabled = !!el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true');
      const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
      const kind = kindOf(el);
      const i = els.length;
      els.push(el);
      desc.push({
        i, tag: el.tagName.toLowerCase(), kind,
        label: labelOf(el),
        box: { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) },
        disabled,
        ...(type ? { type } : {}),
        ...(el.href ? { href: String(el.href).slice(0, 140) } : {}),
        ...(el.getAttribute && el.getAttribute('name') ? { name: norm(el.getAttribute('name')) } : {}),
        ...(type === 'checkbox' || type === 'radio' ? { checked: !!el.checked } : {}),
      });
    }

    // ① shadow DOM：web components 里的节点不在 document.querySelectorAll 里。
    //    shadow 不产生独立坐标空间，所以偏移不用变。
    if (depth < 4) {
      let all;
      try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
      let n = 0;
      for (const el of all) {
        if (++n > 6000) break;
        const sr = el.shadowRoot;
        if (sr) {
          walk(sr, ox, oy, depth + 1);
          if (desc.length >= MAX) return;
        }
      }
    }

    // ② 同源 iframe：它的 document 有独立坐标空间，要加上 frame 的偏移
    if (depth < 3) {
      let frames;
      try { frames = root.querySelectorAll('iframe,frame'); } catch (e) { frames = []; }
      for (const fr of frames) {
        let d = null;
        try { d = fr.contentDocument; } catch (e) { d = null; }
        if (!d || !d.body) continue;
        const rr = fr.getBoundingClientRect();
        if (rr.width < 2 || rr.height < 2) continue;
        walk(d, ox + rr.x + fr.clientLeft, oy + rr.y + fr.clientTop, depth + 1);
        if (desc.length >= MAX) return;
      }
    }
  }

  let title = '', url = location.href, scroll = { y: 0, h: 0, vh: 0 };
  try {
    title = document.title || '';
    scroll = { y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight };
  } catch (e) {}
  walk(document, 0, 0, 0);
  return { els, desc, title, url, scroll };
})()`
}
