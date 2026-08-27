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

const livepreview_render = (text) => {
	const html = md.render(text);
	document.querySelector('.markdown-body').innerHTML = html;
	hljs.highlightAll();
}

const markdownText = document.querySelector('.markdown-body').textContent;
livepreview_render(markdownText);


