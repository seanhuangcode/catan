#!/usr/bin/env node
/*
 * Pushes the newest autopilot session folder (bridge/sessions/<time>/) to its
 * own branch on GitHub, without touching your checkout:
 *
 *   npm run share-session          the newest session
 *   npm run share-session -- <dir> a specific one
 *
 * The commit is built in a temporary index, so your working tree, staged files
 * and current branch stay as they are.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SESSIONS = path.join(__dirname, 'sessions');

function git(args, env) {
  return execFileSync('git', args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function main() {
  let dir = process.argv[2];
  if (!dir) {
    const all = fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter(d => fs.statSync(path.join(SESSIONS, d)).isDirectory()).sort() : [];
    if (!all.length) { console.log('No sessions yet: run npm run play-colonist first.'); process.exit(1); }
    dir = path.join(SESSIONS, all[all.length - 1]);
  }
  dir = path.resolve(dir);
  const rel = path.relative(ROOT, dir);
  const name = 'session-' + path.basename(dir).slice(0, 19).replace(/T/, '-');
  const index = path.join(os.tmpdir(), `catan-share-${process.pid}.index`);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(['read-tree', 'HEAD'], env);
    git(['add', '-f', '--', rel], env);
    const tree = git(['write-tree'], env);
    const commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', `autopilot ${name}`]);
    console.log(`Pushing ${rel} to the branch ${name}…`);
    execFileSync('git', ['-c', 'http.postBuffer=524288000', 'push', 'origin', `${commit}:refs/heads/${name}`], { cwd: ROOT, stdio: 'inherit' });
    console.log(`\nDone. Tell Claude: "I pushed ${name}".`);
  } finally {
    try { fs.unlinkSync(index); } catch (e) { /* not created */ }
  }
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
