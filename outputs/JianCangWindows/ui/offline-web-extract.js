'use strict';

(() => {
  const excluded = 'script, style, noscript, nav, footer, aside, iframe, frame, object, embed, svg, math, template, form, dialog, canvas, audio, video, button, [hidden], [aria-hidden="true"], [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="dialog"]';
  const separators = new Set(['ADDRESS', 'ARTICLE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'HEADER', 'HR', 'MAIN', 'OL', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'TR', 'UL']);
  const kinds = new Map([['P', 'paragraph'], ['BLOCKQUOTE', 'quote'], ['LI', 'item'], ['PRE', 'code'],
    ['H1', 'heading'], ['H2', 'heading'], ['H3', 'heading'], ['H4', 'heading'], ['H5', 'heading'], ['H6', 'heading']]);
  const forReading = text => text.replace(/[^\S\r\n]+/gu, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  function titleOf(fragment) {
    return fragment.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      fragment.querySelector('title')?.textContent || '';
  }

  function mainContent(fragment) {
    const candidates = [...fragment.querySelectorAll('article, main, [role="main"]')].slice(0, 160);
    let longest;
    let bestScore = 0;
    for (const candidate of candidates) {
      const paragraphs = candidate.querySelectorAll('p, blockquote, li, pre');
      let score = 0;
      for (let index = 0; index < Math.min(120, paragraphs.length); index++) {
        score += Math.min(600, paragraphs[index].textContent.trim().length);
      }
      if (!score) score = candidate.textContent.trim().length * 0.5;
      if (score > bestScore) { longest = candidate; bestScore = score; }
    }
    return longest || fragment;
  }

  function inlineText(block, exact = false) {
    const pieces = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node; (node = walker.nextNode());) {
      if (node.nodeType === Node.TEXT_NODE) pieces.push(exact ? node.textContent : node.textContent.replace(/\s+/g, ' '));
      else if (node.tagName === 'BR' || (!exact && (node.tagName === 'P' || node.tagName === 'DIV'))) pieces.push('\n');
    }
    const combined = pieces.join('');
    return exact ? combined.replace(/\r\n?/g, '\n').trim() : forReading(combined);
  }

  function readingBlocks(root) {
    const blocks = [];
    const looseText = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let currentBlock = null;
    let characters = 0;
    let truncated = false;

    function add(text, kind, level) {
      if (!text) return;
      const remaining = Math.min(24_000, 180_000 - characters);
      if (remaining <= 0 || blocks.length >= 480) { truncated = true; return; }
      const limit = text.slice(0, remaining);
      if (limit.length < text.length) truncated = true;
      blocks.push({ kind, text: limit, ...(level && { level }) });
      characters += limit.length;
    }

    function flush() {
      if (!looseText.length) return;
      add(forReading(looseText.join('')), 'paragraph');
      looseText.length = 0;
    }

    for (let node; (node = walker.nextNode());) {
      if (currentBlock?.contains(node)) continue;
      currentBlock = null;
      if (truncated) break;
      if (node.nodeType === Node.TEXT_NODE) { looseText.push(node.textContent.replace(/\s+/g, ' ')); continue; }
      const kind = kinds.get(node.tagName);
      if (kind) {
        flush();
        add(inlineText(node, kind === 'code'), kind, kind === 'heading' ? Number(node.tagName[1]) : undefined);
        currentBlock = node;
      } else if (separators.has(node.tagName)) flush();
    }
    flush();
    return { blocks, truncated };
  }

  function linksOf(root, pageURL) {
    const links = [];
    const seen = new Set();
    for (const anchor of root.querySelectorAll('a[href]')) {
      if (links.length >= 90) break;
      const href = anchor.getAttribute('href')?.trim();
      if (!href || href.startsWith('#') || href.length > 4096) continue;
      try {
        const url = new URL(href, pageURL);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href) || url.href.length > 4096) continue;
        seen.add(url.href);
        links.push({ url: url.href, label: inlineText(anchor).slice(0, 280) || url.hostname });
      } catch { /* An invalid link does not prevent reading the article. */ }
    }
    return links;
  }

  window.extractJianCangOfflineWeb = (html, pageURL) => {
    if (typeof html !== 'string' || html.length > 4 * 1024 ** 2) return null;
    const template = document.createElement('template');
    // Template content remains inert. Only strings extracted from it leave this parser.
    template.innerHTML = html;
    const fragment = template.content;
    const reportedTitle = titleOf(fragment);
    const byline = fragment.querySelector('meta[name="author"]')?.getAttribute('content') || '';
    for (const node of fragment.querySelectorAll(excluded)) node.remove();
    fragment.querySelectorAll('title, link, meta, base').forEach(node => node.remove());
    const root = mainContent(fragment);
    const { blocks, truncated } = readingBlocks(root);
    const primaryTitle = blocks.find(block => block.kind === 'heading' && block.level === 1)?.text;
    const title = forReading(primaryTitle || reportedTitle).slice(0, 600);
    if (blocks[0]?.kind === 'heading' && blocks[0].text === title) blocks.shift();
    return { title, byline, blocks, truncated, links: linksOf(root, pageURL) };
  };
})();
