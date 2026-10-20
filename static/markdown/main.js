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

// --- Embed targets ---------------------------------------------------------

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

const embedAttr = (value) =>
	String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Extensions Obsidian renders as embedded media; anything else is treated as a
// note (or, for unknown types, as a file link).
const MEDIA_EXTENSIONS = {
	image: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'bmp', 'svg', 'svgz', 'webp', 'avif', 'ico', 'tif', 'tiff'],
	video: ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'm4v'],
	audio: ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'aac', '3gp', 'weba'],
	pdf: ['pdf'],
};

const mediaKindOf = (target) => {
	const ext = (target.split('#')[0].split('.').pop() || '').toLowerCase();
	for (const kind of Object.keys(MEDIA_EXTENSIONS)) {
		if (MEDIA_EXTENSIONS[kind].indexOf(ext) !== -1) {
			return kind;
		}
	}
	return null;
};

// `![[target|suffix]]`: for media the suffix is a size (`300`, `300x200`), for
// notes it is an alias.
const parseEmbed = (raw) => {
	const bar = raw.lastIndexOf('|');
	const target = (bar === -1 ? raw : raw.slice(0, bar)).trim();
	const suffix = bar === -1 ? '' : raw.slice(bar + 1).trim();
	const kind = mediaKindOf(target);
	const size = /^\d+(x\d+)?$/.test(suffix) ? suffix.split('x') : null;
	return {
		target,
		suffix,
		kind,
		width: size ? Number(size[0]) : null,
		height: size && size[1] ? Number(size[1]) : null,
	};
};

const embedClass = (base, embed) => `${base} ${embed.kind ? 'wiki-embed-media' : 'wiki-embed-note'}`;

const mediaHtml = (target, { width, height } = {}) => {
	const src = embedAttr('/' + encodePath(target));
	const kind = mediaKindOf(target);
	const box = `${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}`;
	if (kind === 'image') {
		return `<img src="${src}" alt="${embedAttr(target)}"${box}>`;
	}
	if (kind === 'video') {
		return `<video src="${src}"${box} controls></video>`;
	}
	if (kind === 'audio') {
		return `<audio src="${src}" controls></audio>`;
	}
	if (kind === 'pdf') {
		return `<object data="${src}" type="application/pdf"${box}></object>`;
	}
	return `<a class="wiki-embed-file" href="${src}">${embedAttr(target)}</a>`;
};

// Media is emitted as real markup; notes are left empty for loadEmbeds below.
const pushEmbedBody = (state, embed) => {
	if (!embed.kind) {
		return;
	}
	const html = state.push('html_inline', '', 0);
	html.content = mediaHtml(embed.target, embed);
};

// --- Wiki links and embeds -------------------------------------------------

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
		// markdown-it probes rules in silent mode while looking ahead (link,
		// emphasis) and requires the rule to advance the position.
		state.pos = end + 2;
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

// Obsidian embeds: ![[Note]], ![[Note#Heading]], ![[Note#^block-id|Alias]],
// plus embedded files (![[image.png]], ![[image.png|300]], ![[clip.mp4]]).
// Notes are fetched and rendered inline (see loadEmbeds below); media targets
// are emitted as their own element, since rendering a binary file as markdown
// only produces garbage.
md.inline.ruler.after('wiki_link', 'wiki_embed', (state, silent) => {
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
	state.pos = end + 2;
	if (silent) {
		return true;
	}
	const embed = parseEmbed(raw);
	const open = state.push('wiki_embed_open', 'span', 1);
	open.attrs = [
		['class', embedClass('wiki-embed', embed)],
		...(embed.kind ? [] : [['data-embed', embed.target.replace(/"/g, '')]]),
	];
	pushEmbedBody(state, embed);
	state.push('wiki_embed_close', 'span', -1);
	return true;
});

// An embed alone on its line is a block: a `div` nested in the surrounding
// `<p>` would be hoisted out of it by the HTML parser, splitting the paragraph
// and orphaning the text that follows.
md.block.ruler.before('paragraph', 'embed_block', (state, startLine, endLine, silent) => {
	const pos = state.bMarks[startLine] + state.tShift[startLine];
	const line = state.src.slice(pos, state.eMarks[startLine]).trim();
	const m = /^!\[\[([^[\]]+)\]\]$/.exec(line);
	if (!m) {
		return false;
	}
	if (silent) {
		return true;
	}
	const embed = parseEmbed(m[1]);
	state.line = startLine + 1;
	const open = state.push('wiki_embed_open', 'div', 1);
	open.attrs = [
		['class', embedClass('wiki-embed wiki-embed-block', embed)],
		...(embed.kind ? [] : [['data-embed', embed.target.replace(/"/g, '')]]),
	];
	pushEmbedBody(state, embed);
	state.push('wiki_embed_close', 'div', -1);
	return true;
});

// Obsidian block IDs (`^block-id` on their own line) render as subtle
// reference tags: italic and grey, distinct from normal text. The rule
// terminates paragraphs and blockquotes so the tag always sits outside the
// block it labels.
md.block.ruler.before('paragraph', 'block_id', (state, startLine, endLine, silent) => {
	const pos = state.bMarks[startLine] + state.tShift[startLine];
	const line = state.src.slice(pos, state.eMarks[startLine]);
	if (!line.match(/^\^([\w-]+)$/)) {
		return false;
	}
	if (silent) {
		return true;
	}
	state.line = startLine + 1;
	const open = state.push('block_id_open', 'p', 1);
	open.attrs = [['class', 'block-id']];
	const inline = state.push('inline', '', 0);
	inline.content = line;
	inline.children = [];
	state.push('block_id_close', 'p', -1);
	return true;
}, { alt: ['paragraph', 'blockquote'] });

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

const embedError = (msg) =>
	'<div class="wiki-embed-error">' +
	msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) +
	'</div>';

const isMediaContentType = (type) =>
	/^(image|video|audio)\//.test(type) || type.indexOf('application/pdf') !== -1;

/**
 * Fetch an embed target, trying the webroot path and then the path next to the
 * current note (Obsidian resolves links relative to the note first, then by
 * basename anywhere in the vault - the server does the basename lookup).
 */
async function fetchEmbed(filePath) {
	const encoded = encodePath(filePath);
	const docDir = decodeURIComponent(window.location.pathname).replace(/\/[^/]*$/, '');
	const candidates = ['/' + encoded];
	if (docDir && docDir !== '/' && !filePath.startsWith('/')) {
		candidates.push(docDir + '/' + encoded);
	}
	let res;
	for (const url of candidates) {
		res = await fetch(url);
		if (res.ok) {
			return res;
		}
	}
	return res;
}

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
		const res = await fetchEmbed(filePath);
		if (!res.ok) {
			el.innerHTML = embedError('could not load ' + filePath);
			return;
		}
		// `![[image]]` may resolve to a file whose extension was implied: render
		// it as media instead of running its bytes through markdown.
		const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
		if (isMediaContentType(type)) {
			el.innerHTML = mediaHtml(filePath);
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


