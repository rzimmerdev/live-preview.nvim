const md = window.markdownit({
	html: true,
	highlight: function(str, lang) {
		if (lang && hljs.getLanguage(lang)) {
			try {
				return hljs.highlight(str, { language: lang }).value;
			} catch (__) { }
		}

		return ''; // use external default escaping
	}
});
md.use(livepreview_injectLinenumbersPlugin);

md.use(markdownitEmoji);

// Use markdown-it-katex plugin to handle math rendering during markdown parsing
// This prevents markdown-it from corrupting LaTeX syntax before KaTeX can render it
md.use(markdownitKatex);

// GFM-style alert callouts (`> [!type] Title`), with custom types from
// `window.livepreviewConfig.admonition` (injected by template.lua).
md.use(livepreviewAdmonition, ((window.livepreviewConfig || {}).admonition) || {});

// Obsidian embeds: ![[Note]], ![[Note#Heading]], ![[Note#^block-id|Alias]].
// The target's content is fetched and rendered inline (see loadEmbeds below).
md.inline.ruler.before('wiki_link', 'wiki_embed', (state, silent) => {
	const start = state.pos;
	const src = state.src;
	if (
		src.charCodeAt(start) !== 0x21 || // !
		src.charCodeAt(start + 1) !== 0x5b || // [
		src.charCodeAt(start + 2) !== 0x5b
	) {
		return false;
	}
	const end = src.indexOf(']]', start + 3);
	if (end === -1) {
		return false;
	}
	const raw = src.slice(start + 3, end);
	if (raw === '' || raw.includes('[') || raw.includes(']')) {
		return false;
	}
	if (silent) {
		return true;
	}
	let target = raw;
	const bar = raw.lastIndexOf('|');
	if (bar !== -1) {
		target = raw.slice(0, bar);
	}
	const open = state.push('wiki_embed_open', 'div', 1);
	open.attrs = [
		['class', 'wiki-embed'],
		['data-embed', target.replace(/"/g, '')],
	];
	state.push('wiki_embed_close', 'div', -1);
	state.pos = end + 2;
	return true;
});

// Obsidian-style wiki links: [[Note]], [[Note|Alias]], [[Note#Heading]],
// [[Note#^block-id|Alias]], [[#Heading]], [[#^block-id]].
md.inline.ruler.before('link', 'wiki_link', (state, silent) => {
	const start = state.pos;
	const src = state.src;
	if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) {
		return false;
	}
	const end = src.indexOf(']]', start + 2);
	if (end === -1) {
		return false;
	}
	const raw = src.slice(start + 2, end);
	if (raw === '' || raw.includes('[') || raw.includes(']')) {
		return false; // empty or nested: leave as plain text
	}
	if (silent) {
		return true;
	}

	let target = raw;
	let label = raw;
	const bar = raw.lastIndexOf('|');
	if (bar !== -1) {
		target = raw.slice(0, bar);
		label = raw.slice(bar + 1);
	}

	const open = state.push('wiki_link_open', 'a', 1);
	open.attrs = [
		['class', 'wiki-link'],
		['href', '#'],
		['data-wikilink', target.replace(/"/g, '')],
	];
	state.push('text', '', 0).content = label || target;
	state.push('wiki_link_close', 'a', -1);

	state.pos = end + 2;
	return true;
});

// Clicking a wiki link follows it in Neovim (via obsidian.nvim); the preview
// then re-renders when the buffer changes.
document.addEventListener('click', (event) => {
	const link = event.target && event.target.closest && event.target.closest('a.wiki-link');
	if (!link) {
		return;
	}
	event.preventDefault();
	if (window.livepreviewSend) {
		window.livepreviewSend({
			type: 'follow',
			link: '[[' + link.dataset.wikilink + ']]',
		});
	}
});

const embedLoading = new Set();

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

const embedError = (msg) =>
	'<div class="wiki-embed-error">' +
	msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) +
	'</div>';

const slugify = (s) =>
	s
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');

/**
 * Extract the embedded slice (whole note, heading section, or block) from raw
 * markdown. Returns null when the anchor cannot be found.
 */
function extractEmbed(text, anchor) {
	const lines = text.split('\n');
	if (!anchor) {
		return text; // whole note
	}
	if (anchor.startsWith('^')) {
		const id = anchor.slice(1);
		let idx = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === '^' + id) {
				idx = i;
				break;
			}
		}
		if (idx === -1) {
			return null;
		}
		// The block is everything above the block ID line, up to a blank
		// line, a heading, or another block ID.
		let start = idx;
		while (start > 0) {
			const prev = lines[start - 1].trim();
			if (prev === '' || prev.startsWith('#') || /^\^[\w-]+$/.test(prev)) {
				break;
			}
			start--;
		}
		return lines.slice(start, idx).join('\n');
	}
	// Heading anchor: the section under the first heading whose slug matches.
	const wanted = slugify(anchor.replace(/^#/, ''));
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
		if (!m || slugify(m[2]) !== wanted) {
			continue;
		}
		const level = m[1].length;
		let end = lines.length;
		for (let j = i + 1; j < lines.length; j++) {
			const m2 = lines[j].match(/^(#{1,6})\s+/);
			if (m2 && m2[1].length <= level) {
				end = j;
				break;
			}
		}
		return lines.slice(i, end).join('\n');
	}
	return null;
}

async function loadEmbed(el) {
	el.classList.add('loaded');
	const target = el.dataset.embed;
	const hash = target.indexOf('#');
	const path = hash === -1 ? target : target.slice(0, hash);
	const anchor = hash === -1 ? null : target.slice(hash + 1);
	const filePath = path || decodeURIComponent(window.location.pathname).slice(1);

	if (embedLoading.has(filePath)) {
		el.innerHTML = embedError('cyclic embed: ' + filePath);
		return;
	}
	embedLoading.add(filePath);
	try {
		const res = await fetch('/' + encodePath(filePath));
		if (!res.ok) {
			el.innerHTML = embedError('could not load ' + filePath);
			return;
		}
		const slice = extractEmbed(await res.text(), anchor);
		if (slice === null || slice.trim() === '') {
			el.innerHTML = embedError('not found: ' + (anchor || '') + ' in ' + filePath);
			return;
		}
		// Line numbers would point into the embedded file, not the current one.
		const html = md.render(slice).replace(/\sdata-source-line="\d+"/g, '');
		el.innerHTML = html;
		if (typeof livepreview_renderKatex !== 'undefined') {
			livepreview_renderKatex();
		}
		if (typeof livepreview_renderMermaid !== 'undefined') {
			livepreview_renderMermaid();
		}
		if (window.hljs) {
			hljs.highlightAll();
		}
		await loadEmbeds(); // nested embeds
	} finally {
		embedLoading.delete(filePath);
	}
}

async function loadEmbeds() {
	const els = [...document.querySelectorAll('.wiki-embed[data-embed]:not(.loaded)')];
	for (const el of els) {
		await loadEmbed(el);
	}
}

const livepreview_render = (text) => {
	const html = md.render(text);
	document.querySelector('.markdown-body').innerHTML = html;
	hljs.highlightAll();
	loadEmbeds();
}

const markdownText = document.querySelector('.markdown-body').textContent;
livepreview_render(markdownText);


