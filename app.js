const toggleBtn = document.getElementById('theme-toggle');
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

toggleBtn.addEventListener('click', () => {
    const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
});

const GITHUB_RAW = 'https://raw.githubusercontent.com';
const GITHUB_API = 'https://api.github.com';
const slugCache = new Map();

// Load static note config from <script id="notebook-config"> in HTML
function loadStaticConfig() {
    const el = document.getElementById('notebook-config');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
}

// Fetch markdown: GitHub downloadUrl → slug-based lookup → local ./notes/
async function fetchNoteContent(slug, downloadUrl) {
    if (downloadUrl) {
        const res = await fetch(downloadUrl);
        if (res.ok) return await res.text();
        console.warn("GitHub fetch failed:", downloadUrl, res.status);
        return null;
    }
    const config = loadStaticConfig();
    const src = config?.sources?.find(s => s.slug === slug);
    if (src?.repo && src?.path) {
        const [owner, repo] = src.repo.split('/');
        try {
            const res = await fetch(`${GITHUB_RAW}/${owner}/${repo}/${src.path}`);
            if (res.ok) return await res.text();
        } catch (e) { console.warn("Fetch failed for", src.path, e); }
    }
    try {
        const localRes = await fetch(`./notes/${slug}.md`);
        if (localRes.ok) return await localRes.text();
    } catch (e) { /* ignore */ }
    return null;
}

// Discover note slugs: static config > local dir listing > empty
// Returns [{slug, path?}] — path is set for GitHub directory sources
async function autoFetchNoteSlugs() {
    const config = loadStaticConfig();
    if (config?.sources?.length) {
        const results = [];
        for (const src of config.sources) {
            if (src.repo) {
                // GitHub source: try API, fall back to local
                const dirPath = src.path?.endsWith('/') ? src.path : '';
                try {
                    const res = await fetch(`${GITHUB_API}/repos/${src.repo}/contents/${dirPath}`);
                    if (res.ok) {
                        const items = await res.json();
                        for (const item of items) {
                            if (item.type === 'file' && item.name.endsWith('.md')) {
                                const slug = item.name.replace('.md', '');
                                slugCache.set(slug, item.download_url);
                                results.push({ slug, downloadUrl: item.download_url });
                            }
                        }
                    }
                } catch (e) { console.warn("GitHub API failed", e); }
                if (!results.length) {
                    const local = await fetchLocalDir(dirPath || 'notes/');
                    results.push(...local);
                }
            } else if (src.slug) {
                results.push({ slug: src.slug });
            }
        }
        if (results.length) return results;
    }

    // Fallback: local ./notes/
    const local = await fetchLocalDir('notes/');
    return local.length ? local : [{ slug: '' }];
}

// List .md files from a local directory
async function fetchLocalDir(dir) {
    try {
        const res = await fetch(`./${dir}`);
        if (res.ok) {
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            return Array.from(doc.querySelectorAll('a'))
                .filter(a => a.getAttribute('href')?.endsWith('.md'))
                .map(a => ({ slug: a.getAttribute('href').split('/').pop().replace('.md', '') }));
        }
    } catch (e) { /* ignore */ }
    return [];
}

// Metadata field config: key prefix → extractor
const META_CONFIG = [
    { key: 'category', parse: v => v.trim().toLowerCase() === 'article' ? 'articles' : v.trim().toLowerCase() },
    { key: 'date', parse: v => v.trim() },
    { key: 'keywords', parse: v => v.split(',').map(k => k.trim()).filter(Boolean) },
    { key: 'github', parse: v => v.trim() },
    { key: 'short_context', parse: v => v.trim() },
    { key: 'image', parse: v => v.trim() },
    { key: 'title', parse: v => v.trim() },
];

function extractMetadata(slug, rawMarkdown) {
    const lines = rawMarkdown.split('\n');
    let metadataEnd = 0;
    const meta = { slug, title: slug.replace(/-/g, ' '), subtitle: 'Click to read log entry details.', shortContext: '', imageUrl: '', category: 'projects', keywords: [], githubUrl: '', date: '' };

    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const line = lines[i].trim();
        for (const { key, parse } of META_CONFIG) {
            if (line.toLowerCase().startsWith(key + ':')) {
                meta[key] = parse(line.slice(key.length + 1));
                metadataEnd = i + 1;
                break;
            }
        }
    }

    // Fallback: first heading for title
    if (meta.title === slug.replace(/-/g, ' ')) {
        const titleLine = lines.find(l => l.startsWith('# '));
        if (titleLine) meta.title = titleLine.replace('# ', '').trim();
    }

    // Fallback: first non-metadata text for subtitle
    const subtitleLine = lines.slice(metadataEnd).find(l => l.startsWith('> ') || (l.trim().length > 0 && !/^[#!\-*]/.test(l)));
    if (subtitleLine) meta.subtitle = subtitleLine.replace('> ', '').trim();

    // Fallback: image in markdown body
    if (!meta.imageUrl) {
        const imgMatch = rawMarkdown.match(/!\[.*?\]\((.*?)\)/);
        if (imgMatch?.[1]) meta.imageUrl = imgMatch[1];
    }

    if (!meta.shortContext && meta.subtitle !== 'Click to read log entry details.') {
        meta.shortContext = meta.subtitle;
    }

    return meta;
}

// Strip metadata block from markdown before rendering
function stripMetadata(rawMarkdown) {
    const lines = rawMarkdown.split('\n');
    const result = [];
    let inMeta = true;

    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        if (inMeta) {
            if (trimmed === '') { inMeta = false; continue; }
            if (META_CONFIG.some(c => trimmed.startsWith(c.key + ':'))) continue;
        }
        if (!inMeta) result.push(line);
    }
    return result.join('\n');
}

// Render a single feed card
function renderCard(note) {
    const desc = note.shortContext || note.subtitle || '';
    return `
        <div class="project-card ${note.imageUrl ? 'has-image' : 'no-image'}">
            ${note.imageUrl ? `<div class="card-image-context"><a href="#${note.slug}"><img src="${note.imageUrl}" loading="lazy" alt="${note.title || note.slug}"></a></div>` : ''}
            <div class="card-content">
                <div class="card-text-context">
                    <a href="#${note.slug}" class="card-title-link">${note.title}</a>
                    <a href="#${note.slug}" class="card-description-link">${desc}</a>
                </div>
                <div class="card-actions">
                    ${note.keywords?.length ? `<div class="card-keywords-wrap">${note.keywords.map(k => `<span class="keyword">${k}</span>`).join('')}</div>` : ''}
                    ${note.githubUrl ? `<a href="${note.githubUrl}" target="_blank" rel="nofollow" class="dense-link">GitHub</a>` : ''}
                </div>
            </div>
        </div>`;
}

// Assemble feed cards with date sorting
async function renderGlobalFeed(activeCategory = 'home') {
    const slugs = await autoFetchNoteSlugs();
    const allNotes = [];

    for (const entry of slugs) {
        try {
            const raw = await fetchNoteContent(entry.slug, entry.downloadUrl);
            if (!raw) continue;
            allNotes.push(extractMetadata(entry.slug, raw));
        } catch (err) { console.error(err); }
    }

    // Sort newest first
    allNotes.sort((a, b) => (b.date ? new Date(b.date) : new Date(0)) - (a.date ? new Date(a.date) : new Date(0)));

    const projects = allNotes.filter(n => ['projects', 'project'].includes(n.category));
    const articles = allNotes.filter(n => ['articles', 'article'].includes(n.category));

    if (activeCategory === 'home') {
        const html = [];
        if (projects.length) html.push(`<section class="dashboard-section"><a href="#category:projects" class="dashboard-header-link">Active Projects</a><div class="feed-list">${projects.slice(0, 3).map(renderCard).join('')}</div></section>`);
        if (articles.length) html.push(`<section class="dashboard-section"><a href="#category:articles" class="dashboard-header-link">Recent Articles</a><div class="feed-list">${articles.slice(0, 5).map(renderCard).join('')}</div></section>`);
        return html.join('') || '<p style="color:var(--text-muted);font-size:0.85rem">No technical records logged yet.</p>';
    }

    const list = activeCategory === 'projects' ? projects : articles;
    const label = activeCategory === 'projects' ? 'All Projects' : 'All Articles';
    return `<section class="dashboard-section"><a href="#" data-back="home" class="dashboard-header-link is-back">← Back to Dashboard</a><h2 style="font-size:1.2rem;margin-bottom:1rem;font-weight:700">${label} (${list.length})</h2><div class="feed-list">${list.map(renderCard).join('')}</div></section>`;
}

// Route: feed views or individual note
async function executeRoutePipeline() {
    const viewTarget = document.getElementById('view-target');
    const breadcrumbs = document.getElementById('breadcrumbs');
    const hash = window.location.hash.replace('#', '');

    // Feed views
    if (!hash || hash.startsWith('category:')) {
        const cat = hash === 'category:articles' ? 'articles' : (hash === 'category:projects' ? 'projects' : 'home');
        breadcrumbs.style.display = 'none';
        viewTarget.innerHTML = await renderGlobalFeed(cat);
        return;
    }

    // Populate cache for direct navigation (e.g. #test link)
    if (!slugCache.has(hash)) await autoFetchNoteSlugs();

    // Individual note
    breadcrumbs.style.display = 'block';
    breadcrumbs.innerHTML = `<ul><li><a href="#">Home</a></li><li>${hash.replace(/-/g, ' ')}</li></ul>`;

    try {
        const raw = await fetchNoteContent(hash, slugCache.get(hash));
        if (!raw) throw new Error();
        viewTarget.innerHTML = `<article class="markdown-body">${marked.parse(stripMetadata(raw))}</article>`;

        // Inline TOC for multi-heading articles
        const article = viewTarget.querySelector('.markdown-body');
        const headers = article?.querySelectorAll('h1, h2') || [];
        if (headers.length > 1) {
            // Ensure clean IDs
            headers.forEach(h => {
                if (!h.id) {
                    h.id = h.textContent.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+$/, '');
                }
            });

            // Inject TOC styles once
            if (!document.getElementById('toc-styles')) {
                const s = document.createElement('style');
                s.id = 'toc-styles';
                s.textContent = `.inline-toc{margin:1rem 0 1.5rem;padding:0.5rem 0.75rem;border:1px solid var(--border-subtle);border-radius:4px;background:var(--bg-surface)}\n.inline-toc summary{font-size:0.75rem;font-weight:600;color:var(--text-muted);cursor:pointer;user-select:none;text-transform:uppercase;letter-spacing:0.04em}\n.inline-toc-list{list-style:none;padding:0;margin:0.4rem 0 0;display:flex;flex-direction:column;gap:0.2rem}\n.inline-toc-list li a{display:block;font-size:0.8rem;color:var(--text-muted);text-decoration:none;padding:0.15rem 0;transition:color 0.15s ease}\n.inline-toc-list li a:hover{color:var(--text-primary)}`;
                document.head.appendChild(s);
            }

            // Build TOC
            const tocHtml = '<nav class="inline-toc" aria-label="Table of contents"><details><summary class="inline-toc-summary">On this page</summary><ul class="inline-toc-list">' +
                Array.from(headers).map(h => `<li><a onclick="event.preventDefault();document.getElementById('${h.id}')&&document.getElementById('${h.id}').scrollIntoView({behavior:'smooth',block:'start'});return false;">${h.textContent}</a></li>`).join('') +
                '</ul></details></nav>';

            const h1 = article.querySelector('h1');
            (h1 || article).insertAdjacentHTML(h1 ? 'afterend' : 'afterbegin', tocHtml);
        }

        if (window.Prism) Prism.highlightAll();
        if (window.renderMathInElement) {
            renderMathInElement(viewTarget, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false, strict: 'ignore' });
        }
    } catch {
        viewTarget.innerHTML = `<div class="error-panel"><h2>404 - Note Not Found</h2><p>The document record <code>notes/${hash}.md</code> could not be loaded.</p><a href="#" role="button" class="compact-btn">Return Home</a></div>`;
    }
}

window.addEventListener('hashchange', executeRoutePipeline);
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('view-target').innerHTML = '';
    executeRoutePipeline();
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-back="home"]');
        if (btn) {
            e.preventDefault();
            window.location.hash = '';
        }
    });
});
