// lib/calibration.js — the user's taste, stored as examples.
//
// The plan's insight: "7 = adequate" teaches an agent nothing, but "here are
// three things this user rated 8" does. So calibration is anchors — real past
// annotations with their ratings — plus standing preferences promoted from
// complaints that keep recurring. One file per user, shipped with every
// export. This accumulates across projects and is the asset that grows.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'calibration.json');
const shotsRoot = () => path.join(app.getPath('userData'), 'calibration');

let cache = null;

function load() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  cache = {
    version: 2,
    updatedAt: raw.updatedAt || null,
    anchors: Array.isArray(raw.anchors) ? raw.anchors : [],
    standingPreferences: Array.isArray(raw.standingPreferences) ? raw.standingPreferences : [],
  };
  return cache;
}

function save() {
  const data = load();
  data.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file());
}

/** @param {{rating:number, axis:string, summary:string, screenshot?:string, note?:string}} anchor */
function addAnchor(anchor) {
  const rating = Math.round(Number(anchor.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 10) throw new Error('Anchor rating must be 1–10.');
  const summary = String(anchor.summary || '').trim();
  if (!summary) throw new Error('An anchor needs a summary of what earned the rating.');
  load().anchors.push({
    rating,
    axis: String(anchor.axis || 'general').slice(0, 40),
    summary: summary.slice(0, 300),
    screenshot: anchor.screenshot ? String(anchor.screenshot).slice(0, 300) : null,
    note: String(anchor.note || '').slice(0, 300),
    addedAt: new Date().toISOString(),
  });
  save();
}

function addStandingPreference(text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('An empty preference says nothing.');
  const data = load();
  const exists = data.standingPreferences.some(p => p.toLowerCase() === clean.toLowerCase());
  if (!exists) {
    data.standingPreferences.push(clean.slice(0, 300));
    save();
  }
  return !exists;
}

/** calibration.md — rendered for the export folder, anchors high-to-low so an
 *  agent reads what excellence looks like before what failure looks like. */
function renderMarkdown() {
  const data = load();
  const lines = ['# Calibration — how this reviewer\'s ratings map to real examples', ''];
  lines.push('Ratings are anchored by example, not by rubric. Match the reviewer\'s taste');
  lines.push('to these, then apply it to the annotations in REVIEW.md.', '');

  if (data.standingPreferences.length) {
    lines.push('## Standing preferences (apply everywhere, always)', '');
    for (const pref of data.standingPreferences) lines.push(`- ${pref}`);
    lines.push('');
  }

  if (data.anchors.length) {
    lines.push('## Rating anchors', '');
    const sorted = data.anchors.slice().sort((a, b) => b.rating - a.rating);
    for (const anchor of sorted) {
      lines.push(`### ${anchor.rating}/10 · ${anchor.axis}`);
      lines.push(anchor.summary);
      if (anchor.note) lines.push(`> ${anchor.note}`);
      if (anchor.screenshot) lines.push(`Screenshot: ${anchor.screenshot}`);
      lines.push('');
    }
  } else {
    lines.push('_No anchors recorded yet — treat ratings as a plain 1–10 scale._', '');
  }
  return lines.join('\n');
}

module.exports = { load, addAnchor, addStandingPreference, renderMarkdown, shotsRoot };
