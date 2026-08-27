// GFM-style alerts: `> [!type] Title` render as admonition boxes.
//
// Custom types are configured through the `admonition` live-preview option:
//   require('livepreview.config').set({
//     admonition = { types = { definition = { color = '#36bf24' } } },
//   })
// A plain string shorthand is also accepted (`definition = '#36bf24'`).
//
// The title is the capitalized type name, followed by any text after the
// tag: `> [!definition] Group Theory` renders as "Definition - Group Theory".
// Built-in GFM types (note, tip, important, warning, caution) need no config;
// their styling comes from admonition.css. Custom types with a color get an
// inline `--admonition-accent` variable that admonition.css consumes.

const ADMONITION_BUILTIN_TYPES = ['note', 'tip', 'important', 'warning', 'caution']

const admonitionTitleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

const admonitionHexToRgba = (color, alpha) => {
  let c = String(color).replace('#', '')
  if (c.length === 3) c = c.split('').map((x) => x + x).join('')
  if (!/^[0-9a-f]{6}$/i.test(c)) return null
  const n = parseInt(c, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function livepreviewAdmonition (md, opts = {}) {
  const custom = (opts && opts.types) || {}
  const colorOf = (tag) => {
    const def = custom[tag]
    if (typeof def === 'string') return def
    return (def && def.color) || null
  }

  md.core.ruler.push('admonition', (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const open = state.tokens[i]
      if (open.type !== 'blockquote_open') continue

      // Locate the matching close token (blockquotes may nest).
      let depth = 1
      let close = -1
      for (let j = i + 1; j < state.tokens.length; j++) {
        const t = state.tokens[j]
        if (t.type === 'blockquote_open') depth++
        else if (t.type === 'blockquote_close' && --depth === 0) { close = j; break }
      }
      if (close === -1) continue

      // The alert marker must be the start of the first paragraph.
      const paraOpen = i + 1
      const para = state.tokens[paraOpen]
      if (!para || para.type !== 'paragraph_open') continue
      const inline = state.tokens[paraOpen + 1]
      if (!inline || inline.type !== 'inline' || !inline.children || !inline.children.length) continue
      const first = inline.children[0]
      if (first.type !== 'text') continue
      const m = /^\[!([^\]]+)\](.*)$/.exec(first.content)
      if (!m) continue

      const tag = m[1].trim().toLowerCase()
      const color = colorOf(tag)
      const known = ADMONITION_BUILTIN_TYPES.indexOf(tag) !== -1
      if (!known && !color) continue // unknown type: keep the blockquote as-is

      // Title: the marker plus everything after it on the first line. Inline
      // rules may split the line (e.g. `$\sigma$-algebra` becomes a math
      // token), so collect the tokens up to the first softbreak and render
      // them as inline content.
      const markerEnd = '[!' + m[1] + ']'
      const titleTokens = []
      const remainder = first.content.slice(markerEnd.length).trimStart()
      if (remainder !== '') {
        const t = new state.Token('text', '', 0)
        t.content = remainder
        titleTokens.push(t)
      }
      let consumed = 1
      while (consumed < inline.children.length && inline.children[consumed].type !== 'softbreak') {
        titleTokens.push(inline.children[consumed])
        consumed++
      }

      // blockquote -> div.admonition
      open.type = 'admonition_open'
      open.tag = 'div'
      open.attrs = [['class', `admonition admonition-${tag}${color ? ' admonition-custom' : ''}`]]
      if (color) {
        const style = [`--admonition-accent: ${color}`]
        const bg = admonitionHexToRgba(color, 0.1)
        if (bg) style.push(`--admonition-bg: ${bg}`, `--admonition-border: ${admonitionHexToRgba(color, 0.2)}`)
        open.attrs.push(['style', style.join('; ')])
      }
      const closeTok = state.tokens[close]
      closeTok.type = 'admonition_close'
      closeTok.tag = 'div'

      // Strip the marker and title tokens from the body, along with the line
      // break that follows them, so the body starts on a clean line.
      inline.children.splice(0, consumed)
      while (inline.children.length &&
             (inline.children[0].type === 'softbreak' ||
              (inline.children[0].type === 'text' && inline.children[0].content === ''))) {
        inline.children.shift()
      }

      // Drop the paragraph entirely if the marker was all it contained.
      let insertAt = paraOpen
      if (!inline.children.length) {
        state.tokens.splice(paraOpen, 3)
        insertAt = paraOpen
      }

      // Prepend the title paragraph.
      const pOpen = new state.Token('paragraph_open', 'p', 1)
      pOpen.attrs = [['class', 'admonition-title']]
      const tInline = new state.Token('inline', '', 0)
      tInline.children = [new state.Token('text', '', 0)]
      tInline.children[0].content = admonitionTitleCase(tag)
      if (titleTokens.length) {
        const sep = new state.Token('text', '', 0)
        sep.content = ' - '
        tInline.children.push(sep)
        for (const tk of titleTokens) {
          tInline.children.push(tk)
        }
      }
      const pClose = new state.Token('paragraph_close', 'p', -1)
      state.tokens.splice(insertAt, 0, pOpen, tInline, pClose)

      // Skip past the transformed block.
      let d = 1
      let end = i + 1
      for (; end < state.tokens.length; end++) {
        const t = state.tokens[end]
        if (t.type === 'admonition_open' || t.type === 'blockquote_open') d++
        else if ((t.type === 'admonition_close' || t.type === 'blockquote_close') && --d === 0) break
      }
      i = end
    }
  })
}

window.livepreviewAdmonition = livepreviewAdmonition
