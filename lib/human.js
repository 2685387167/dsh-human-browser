/**
 * human.js — 「像人」这件事的可计算部分。
 *
 * 设计原则：
 *  1. 这里只产出**数据**（坐标序列、时间表），不碰浏览器。扩展端只负责按时间表派发，
 *     所以换策略不用动扩展，也不会把随机性散落在两处。
 *  2. 所有随机数走可注入的 rng，测试可复现。
 *  3. 每一项参数都能从 profile 覆盖 —— 风控一收紧，改配置就够，不用改代码。
 */

// ── 随机 ────────────────────────────────────────────────────────────────────

/** mulberry32：小而够用的可播种 PRNG */
export function makeRng(seed) {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 系统熵种子 */
export function entropySeed() {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a, b, t) => a + (b - a) * t

/** [lo, hi] 均匀 */
export function between(rng, lo, hi) {
  return lo + (hi - lo) * rng()
}

/** 整数 [lo, hi] 闭区间 */
export function intBetween(rng, lo, hi) {
  return Math.round(between(rng, lo, hi))
}

/** 截断正态（Box-Muller + 拒绝截断）——真人瞄准的落点分布是中心偏散，不是均匀 */
export function gaussian(rng, mean = 0, sigma = 1, limit = 2.5) {
  for (let i = 0; i < 32; i++) {
    const u1 = Math.max(rng(), 1e-9)
    const u2 = rng()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    if (Math.abs(z) <= limit) return mean + z * sigma
  }
  return mean
}

// ── 默认参数档位 ─────────────────────────────────────────────────────────────

/**
 * 三档节奏。cautious 用于强风控站（Cloudflare / DataDome 一类），
 * normal 是默认，fast 用于自己家的后台、没有风控的站。
 */
export const PROFILES = {
  cautious: {
    moveStepsPer100px: 9,     // 每 100px 路径打几个点
    moveMinSteps: 10,
    moveMaxSteps: 46,
    moveDelay: [11, 26],      // 每个点之间的间隔 ms
    curveDeviation: [0.14, 0.30], // 控制点偏离直线的比例
    jitter: [0.4, 2.2],       // 每个点的额外抖动 px
    overshootChance: 0.22,    // 末端过冲再回到目标
    aimPause: [90, 320],      // 按下前的「瞄准」停顿
    stepPause: [420, 1500],   // 两个动作之间
    thinkPause: [700, 2600],  // 一个"意图"开始前
    longPauseChance: 0.07,
    longPause: [1800, 5200],
    typeDelay: [70, 190],
    typeWordBoundary: [110, 320],
    typePunctPause: [220, 620],
  },
  normal: {
    moveStepsPer100px: 7,
    moveMinSteps: 7,
    moveMaxSteps: 34,
    moveDelay: [8, 20],
    curveDeviation: [0.10, 0.24],
    jitter: [0.3, 1.6],
    overshootChance: 0.16,
    aimPause: [60, 220],
    stepPause: [260, 900],
    thinkPause: [380, 1500],
    longPauseChance: 0.05,
    longPause: [1200, 3400],
    typeDelay: [45, 135],
    typeWordBoundary: [80, 240],
    typePunctPause: [150, 420],
  },
  fast: {
    moveStepsPer100px: 5,
    moveMinSteps: 4,
    moveMaxSteps: 22,
    moveDelay: [4, 11],
    curveDeviation: [0.06, 0.16],
    jitter: [0.2, 1.0],
    overshootChance: 0.08,
    aimPause: [25, 90],
    stepPause: [90, 320],
    thinkPause: [120, 480],
    longPauseChance: 0.02,
    longPause: [600, 1500],
    typeDelay: [22, 70],
    typeWordBoundary: [40, 120],
    typePunctPause: [70, 200],
  },
}

export function resolveProfile(name, overrides = {}) {
  const base = PROFILES[name] || PROFILES.normal
  return { ...base, ...overrides }
}

// ── 鼠标轨迹 ─────────────────────────────────────────────────────────────────

/** 三次贝塞尔单点 */
function cubic(p0, p1, p2, p3, t) {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/**
 * 速度曲线：真人手在移动中是「慢—快—慢」，末端还会修正。
 * 输入线性 t（0..1），输出被重映射后的 t'。
 * easeInOutCubic 会让中段特别快、两头特别慢，接近真实。
 */
function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * 生成一条从 from 到 to 的鼠标移动计划。
 *
 * @returns {{ points: Array<{x:number,y:number,delay:number}>, final: {x:number,y:number} }}
 *   points 不含终点本身；调用方派发完 points 后再落点到 final（final 可能在 points 里）。
 */
export function movePlan(from, to, profile, rng) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)

  // 距离极短：真人就是一小抖动，别硬凑成几十个点
  if (dist < 6) {
    return {
      points: [
        {
          x: to.x + gaussian(rng, 0, 0.6, 1.5),
          y: to.y + gaussian(rng, 0, 0.6, 1.5),
          delay: intBetween(rng, ...profile.moveDelay),
        },
      ],
      final: { x: to.x, y: to.y },
    }
  }

  const steps = clamp(
    Math.round((dist / 100) * profile.moveStepsPer100px),
    profile.moveMinSteps,
    profile.moveMaxSteps,
  )

  // 控制点：垂直于直线方向偏离，偏离量和方向都随机 → 弧线的弯法每次不同
  const nx = -(to.y - from.y) / dist
  const ny = (to.x - from.x) / dist
  const devFrac1 = between(rng, ...profile.curveDeviation) * (rng() < 0.5 ? -1 : 1)
  const devFrac2 = between(rng, ...profile.curveDeviation) * (rng() < 0.5 ? -1 : 1)
  const p1 = {
    x: lerp(from.x, to.x, between(rng, 0.18, 0.35)) + nx * dist * devFrac1,
    y: lerp(from.y, to.y, between(rng, 0.18, 0.35)) + ny * dist * devFrac1,
  }
  const p2 = {
    x: lerp(from.x, to.x, between(rng, 0.62, 0.85)) + nx * dist * devFrac2,
    y: lerp(from.y, to.y, between(rng, 0.62, 0.85)) + ny * dist * devFrac2,
  }

  const points = []
  for (let i = 1; i <= steps; i++) {
    const raw = i / steps
    const t = easeInOut(raw)
    const p = cubic(from, p1, p2, to, t)
    const j = between(rng, ...profile.jitter)
    // 抖动在接近终点时衰减，否则落点会飘
    const decay = 1 - raw * 0.72
    points.push({
      x: p.x + gaussian(rng, 0, j, 2) * decay,
      y: p.y + gaussian(rng, 0, j, 2) * decay,
      delay: intBetween(rng, ...profile.moveDelay),
    })
  }

  // 末端过冲：先越过目标一点点，再折回 —— 真人手过冲是常态
  if (rng() < profile.overshootChance) {
    const over = between(rng, 2, 9)
    const ang = rng() * Math.PI * 2
    points.push({
      x: to.x + Math.cos(ang) * over,
      y: to.y + Math.sin(ang) * over,
      delay: intBetween(rng, ...profile.moveDelay),
    })
    points.push({
      x: to.x + gaussian(rng, 0, 1.2, 2),
      y: to.y + gaussian(rng, 0, 1.2, 2),
      delay: intBetween(rng, ...profile.aimPause) * 0.5,
    })
  }

  return { points, final: { x: to.x, y: to.y } }
}

/**
 * 在元素可见盒里挑一个落点。
 *
 * 真人不是点正中心：视线先落在中心附近，手跟着，落点呈中心偏散的正态分布；
 * 同时会避开边缘（边缘视觉上"不稳"，而且有时是边框/圆角）。
 */
export function pickPoint(box, profile, rng) {
  const w = Math.max(1, box.w)
  const h = Math.max(1, box.h)
  const inset = Math.min(6, Math.min(w, h) * 0.12) // 避开边缘
  const usableW = Math.max(1, w - inset * 2)
  const usableH = Math.max(1, h - inset * 2)
  const cx = box.x + w / 2
  const cy = box.y + h / 2

  // σ 取可用尺寸的 0.24 —— 再小就过于"每次都点正中心"，再大就频繁贴边
  const sigmaX = usableW * 0.24
  const sigmaY = usableH * 0.24

  // 拒绝采样：越界就重抽，而不是 clamp —— clamp 会让落点在边缘堆积出一条线
  let x = cx
  let y = cy
  for (let i = 0; i < 24; i++) {
    x = cx + gaussian(rng, 0, sigmaX, 2)
    y = cy + gaussian(rng, 0, sigmaY, 2)
    if (x > box.x + inset && x < box.x + w - inset && y > box.y + inset && y < box.y + h - inset) {
      return { x: Math.round(x), y: Math.round(y) }
    }
  }
  // 极窄元素（比如 1px 的分隔线命中区）退化为中心附近
  return {
    x: Math.round(clamp(x, box.x + inset, box.x + w - inset)),
    y: Math.round(clamp(y, box.y + inset, box.y + h - inset)),
  }
}

/** 一个「意图」开始前的停顿（看页面、想下一步） */
export function thinkPause(profile, rng) {
  return intBetween(rng, ...profile.thinkPause)
}

/** 两个动作之间的停顿；偶尔来一次长停顿（走神 / 读内容） */
export function stepPause(profile, rng) {
  if (rng() < profile.longPauseChance) return intBetween(rng, ...profile.longPause)
  return intBetween(rng, ...profile.stepPause)
}

// ── 键盘 ─────────────────────────────────────────────────────────────────────

const WORD_BREAK = new Set([' ', '\t', '\n', '\r', '　'])
const PUNCT = new Set([...'.,;:!?，。；：！？、）)」』】》'])

/**
 * 逐字输入的时间表。
 * 真实打字：单词内快、词间慢、标点后明显停一下、Shift 类字符稍慢。
 */
export function typePlan(text, profile, rng) {
  const out = []
  let prev = ''
  for (const ch of String(text)) {
    let delay = intBetween(rng, ...profile.typeDelay)

    if (WORD_BREAK.has(prev)) delay += intBetween(rng, ...profile.typeWordBoundary)
    if (PUNCT.has(prev)) delay += intBetween(rng, ...profile.typePunctPause)

    // 同一字符连打（比如 "aaa"）会有个收敛的节奏
    if (ch === prev) delay = Math.round(delay * 0.82)

    // 大写与符号要抬手按 Shift
    if (/[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(ch)) delay += intBetween(rng, 42, 100)

    const kind = isPrintableAscii(ch) ? 'key' : 'insert'
    out.push({ ch, delay, kind })
    prev = ch
  }
  return out
}

export function isPrintableAscii(ch) {
  const c = ch.codePointAt(0)
  return c >= 0x20 && c <= 0x7e
}

// ── 滚动 ─────────────────────────────────────────────────────────────────────

/**
 * 一次滚动的分段计划。真人滚动是"几下滚轮 + 惯性收尾"，不是一次性跳到底。
 */
export function scrollPlan(totalDelta, profile, rng) {
  const abs = Math.abs(totalDelta)
  if (abs < 40) {
    return [{ delta: totalDelta, delay: intBetween(rng, ...profile.moveDelay) }]
  }
  const steps = clamp(Math.round(abs / 110), 2, 9)
  const parts = []
  let remaining = abs
  for (let i = 0; i < steps; i++) {
    const last = i === steps - 1
    // 前重后轻：最后两段变小，形成惯性收尾
    const weight = last ? remaining : remaining * between(rng, 0.42, 0.72)
    const d = Math.max(1, Math.round(weight))
    parts.push({
      delta: (totalDelta < 0 ? -1 : 1) * d,
      delay: intBetween(rng, ...profile.moveDelay) * 2 + intBetween(rng, 4, 26),
    })
    remaining -= d
    if (remaining <= 0) break
  }
  return parts
}
