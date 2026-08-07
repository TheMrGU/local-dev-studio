// Unit tests for lib/sitemap.js — the pure sitemap parsing and the fetch
// orchestration (with fetchText injected, so no network is ever touched).
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { isSitemapUrl, parseSitemap, fetchSitemapUrls } = require('../lib/sitemap');

test('isSitemapUrl wants an .xml pathname with "sitemap" in it', () => {
  assert.ok(isSitemapUrl('https://a.com/sitemap.xml'));
  assert.ok(isSitemapUrl('https://a.com/sitemap_index.xml'));
  assert.ok(isSitemapUrl('https://a.com/wp-sitemap.xml'));
  assert.ok(isSitemapUrl('https://a.com/post-sitemap.xml?page=2'), 'query string is fine');
  assert.ok(!isSitemapUrl('https://a.com/feed.xml'));
  assert.ok(!isSitemapUrl('https://a.com/sitemap.html'));
  assert.ok(!isSitemapUrl('garbage'));
});

test('parseSitemap reads a urlset and keeps only http(s) entries', () => {
  const { kind, urls } = parseSitemap(`<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://a.com/</loc><lastmod>2026-01-01</lastmod></url>
      <url><loc>
        https://a.com/pricing
      </loc></url>
      <url><loc>ftp://a.com/nope</loc></url>
    </urlset>`);
  assert.equal(kind, 'urlset');
  assert.deepEqual(urls, ['https://a.com/', 'https://a.com/pricing']);
});

test('parseSitemap unwraps CDATA and XML entities', () => {
  const { urls } = parseSitemap(
    '<urlset><url><loc><![CDATA[https://a.com/?x=1&amp;y=2]]></loc></url>'
    + '<url><loc>https://a.com/a&amp;b</loc></url></urlset>');
  assert.deepEqual(urls, ['https://a.com/?x=1&y=2', 'https://a.com/a&b']);
});

test('parseSitemap recognises a sitemapindex', () => {
  const { kind, urls } = parseSitemap(
    '<sitemapindex><sitemap><loc>https://a.com/pages.xml</loc></sitemap></sitemapindex>');
  assert.equal(kind, 'index');
  assert.deepEqual(urls, ['https://a.com/pages.xml']);
});

test('fetchSitemapUrls flattens an index, dedupes, strips fragments and caps', async () => {
  const docs = {
    'https://a.com/sitemap.xml': '<sitemapindex>'
      + '<sitemap><loc>https://a.com/one.xml</loc></sitemap>'
      + '<sitemap><loc>https://a.com/two.xml</loc></sitemap></sitemapindex>',
    'https://a.com/one.xml': '<urlset><url><loc>https://a.com/x</loc></url>'
      + '<url><loc>https://a.com/y#section</loc></url></urlset>',
    'https://a.com/two.xml': '<urlset><url><loc>https://a.com/y</loc></url>'
      + '<url><loc>https://a.com/z</loc></url></urlset>',
  };
  const fetchText = async url => {
    if (!docs[url]) throw new Error('404: ' + url);
    return docs[url];
  };
  assert.deepEqual(
    await fetchSitemapUrls('https://a.com/sitemap.xml', { fetchText }),
    ['https://a.com/x', 'https://a.com/y', 'https://a.com/z']);
  assert.deepEqual(
    await fetchSitemapUrls('https://a.com/sitemap.xml', { fetchText, limit: 1 }),
    ['https://a.com/x']);
});

test('fetchSitemapUrls survives a broken child sitemap and refuses an empty one', async () => {
  const docs = {
    'https://a.com/sitemap.xml': '<sitemapindex>'
      + '<sitemap><loc>https://a.com/broken.xml</loc></sitemap>'
      + '<sitemap><loc>https://a.com/ok.xml</loc></sitemap></sitemapindex>',
    'https://a.com/ok.xml': '<urlset><url><loc>https://a.com/page</loc></url></urlset>',
  };
  const fetchText = async url => {
    if (!docs[url]) throw new Error('boom');
    return docs[url];
  };
  assert.deepEqual(
    await fetchSitemapUrls('https://a.com/sitemap.xml', { fetchText }),
    ['https://a.com/page']);
  await assert.rejects(
    fetchSitemapUrls('https://a.com/empty.xml', { fetchText: async () => '<urlset></urlset>' }),
    /lists no pages/);
});
