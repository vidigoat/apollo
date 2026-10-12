#!/usr/bin/env node
/**
 * Record the real pull request Apollo checked, so the site can show it.
 *
 *   node scripts/real-pr.js [owner/repo] [number]     # default vidigoat/apollo-demo 1
 *
 * Reads the pull request and its latest check run from GitHub's API (through `gh`) and writes
 * public/real-pr.json: the pull request, the run, its conclusion and its annotations, each with its
 * link. The page renders that file; nothing about the check is typed into a component, and every
 * line links back to GitHub, where anyone can see it for themselves.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = process.argv[2] || 'vidigoat/apollo-demo';
const num = process.argv[3] || '1';
const api = (p) => JSON.parse(execFileSync('gh', ['api', p], { encoding: 'utf8' }));

const pr = api(`repos/${repo}/pulls/${num}`);
const runs = api(`repos/${repo}/commits/${pr.head.sha}/check-runs`).check_runs;
const run = runs.sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
if (!run) throw new Error('no check run on the head commit yet');
const annotations = api(`repos/${repo}/check-runs/${run.id}/annotations`)
  .filter((a) => a.title && a.title.startsWith('Apollo:'))
  .map((a) => ({ level: a.annotation_level, title: a.title, message: a.message }));

const out = {
  repo,
  pr: { number: pr.number, title: pr.title, url: pr.html_url, state: pr.state },
  run: { name: run.name, conclusion: run.conclusion, url: run.html_url, completedAt: run.completed_at },
  annotations,
};
fs.writeFileSync(path.join(__dirname, '..', 'public', 'real-pr.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`  ${repo}#${num}: ${run.conclusion}, ${annotations.length} Apollo annotation${annotations.length === 1 ? '' : 's'}`);
