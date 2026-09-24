import { useMemo, useRef } from 'react'
import { createTextIndex } from '../textIndex'

/**
 * 把文本按所有编码边界切成原子段，每段携带覆盖它的编码列表。
 * 区间一律为 Unicode 码位坐标（与 API / 数据库一致）；切原文时经索引
 * 转成 UTF-16 偏移，绝不会把补充平面字符（如 emoji）的代理对切开。
 *
 * 扫线（sweep line）实现：为每条标注生成「开始 / 结束」两个事件，按码位
 * 坐标排序后顺序扫描、维护当前活动标注集合，避免在每个边界都重新扫描全部
 * 标注（旧实现为 O(边界数 × 标注数)，单篇数千条重叠标注时打开 / 编辑文档
 * 明显卡顿）。语义与旧实现严格一致：
 *  - 片段半开 [start, end)；同一坐标先处理结束事件、再处理开始事件，因此
 *    首尾相接的 [a,b) 与 [b,c) 在 b 点不算同时覆盖，重叠（共占某一码位）
 *    才算；
 *  - 活动集合始终保持标注在入参数组中的先后次序，与旧版逐段 filter 的
 *    结果相同，多重叠加渐变条带的颜色顺序不变；
 *  - 起止位置先夹取到 [0, 全文码位数]，零长标注跳过，扫线产生的零长片段
 *    不输出（空片段不渲染）。
 */
export function buildSegments(content, codings) {
  const idx = createTextIndex(content)
  const events = []
  for (let i = 0; i < codings.length; i++) {
    const c = codings[i]
    const start = Math.max(0, c.start)
    const end = Math.min(idx.length, c.end)
    if (end <= start) continue
    // type 0 = 结束、1 = 开始：同点先结束再开始（半开区间，相接不算重叠）
    events.push({ pos: start, type: 1, index: i })
    events.push({ pos: end, type: 0, index: i })
  }
  events.sort((a, b) => a.pos - b.pos || a.type - b.type || a.index - b.index)

  // 活动标注下标，始终按 codings 入参次序升序，二分维持有序
  const active = []
  const lowerBound = (target) => {
    let lo = 0
    let hi = active.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (active[mid] < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const segments = []
  let cursor = 0
  const pushSegment = (end) => {
    if (end <= cursor) return
    segments.push({
      start: cursor,
      end,
      text: idx.slice(cursor, end),
      codings: active.length === 0 ? NO_CODINGS : active.map((i) => codings[i]),
    })
  }

  for (const ev of events) {
    pushSegment(ev.pos)
    if (ev.type === 1) active.splice(lowerBound(ev.index), 0, ev.index)
    else active.splice(lowerBound(ev.index), 1)
    cursor = ev.pos
  }
  pushSegment(idx.length)
  return segments
}

const NO_CODINGS = Object.freeze([])

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map((x) => x + x).join('') : m, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function segmentStyle(codings) {
  if (codings.length === 0) return undefined
  const colors = codings.map((c) => c.code_color || '#999')
  if (colors.length === 1) {
    return {
      background: hexToRgba(colors[0], 0.32),
      borderBottom: `2px solid ${colors[0]}`,
    }
  }
  // 多重叠加：均分渐变条带，直观呈现可重叠编码
  const stops = colors
    .map((col, i) => {
      const from = (i / colors.length) * 100
      const to = ((i + 1) / colors.length) * 100
      return `${hexToRgba(col, 0.42)} ${from}%, ${hexToRgba(col, 0.42)} ${to}%`
    })
    .join(', ')
  return {
    background: `linear-gradient(135deg, ${stops})`,
    borderBottom: `2px solid ${colors[colors.length - 1]}`,
  }
}

/**
 * 文本视图：渲染原子段并把鼠标拖选映射回字符区间。
 * DOM Selection / Range 使用 UTF-16 码元偏移，这里统一换算为码位下标后
 * 再回调 onSelect，保证提交给后端的区间按 Unicode 字符定位、不拆代理对。
 */
export default function TextView({ content, codings, selection, flashRange, onSelect }) {
  const ref = useRef(null)
  const segments = useMemo(() => buildSegments(content, codings), [content, codings])
  const index = useMemo(() => createTextIndex(content), [content])

  function locateOffset(node, offset) {
    const container = ref.current
    if (!container) return null
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
    const span = el && el.closest ? el.closest('[data-s]') : null
    if (!span || !container.contains(span)) return null
    try {
      // span.dataset.s 是码位起点；Range 内文字长度是 UTF-16 码元数，
      // 经索引把“码位起点 + 码元偏移”换算成绝对码位下标
      const spanStart = Number(span.dataset.s)
      const spanUtf16 = index.toUtf16(spanStart)
      const range = document.createRange()
      range.selectNodeContents(span)
      range.setEnd(node, offset)
      return index.toCodePoint(spanUtf16 + range.toString().length)
    } catch {
      return null
    }
  }

  function handleMouseUp() {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const start = locateOffset(sel.anchorNode, sel.anchorOffset)
    const end = locateOffset(sel.focusNode, sel.focusOffset)
    if (start == null || end == null) return
    const [s, e] = start <= end ? [start, end] : [end, start]
    if (e > s) onSelect({ start: s, end: e })
  }

  function inRange(seg, range) {
    return range && seg.start < range.end && seg.end > range.start
  }

  return (
    <div
      ref={ref}
      className="text-view"
      onMouseUp={handleMouseUp}
      data-testid="text-view"
    >
      {segments.map((seg) => {
        const classes = ['seg']
        if (seg.codings.length > 0) classes.push('coded')
        if (inRange(seg, selection)) classes.push('selected')
        if (inRange(seg, flashRange)) classes.push('flash')
        const title =
          seg.codings.length > 0
            ? seg.codings
                .map((c) => `${c.code_name} [${c.start}, ${c.end})`)
                .join('\n')
            : undefined
        return (
          <span
            key={seg.start}
            data-s={seg.start}
            data-e={seg.end}
            className={classes.join(' ')}
            style={segmentStyle(seg.codings)}
            title={title}
          >
            {seg.text}
          </span>
        )
      })}
    </div>
  )
}
