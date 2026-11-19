#!/usr/bin/env node
// Publishes a built web bundle to the server, and optionally points a channel at it.
//
//   node scripts/publish-bundle.mjs --dir dist --build 421 [--min-native 2.1.0] [--release] [--rollout 10]
//
// Two steps, deliberately separate (app/api/v1/releases.py):
//   publish  uploads the zip and records it. No phone is affected.
//   release  points the channel at it. This is the moment it goes live, and the moment to undo.
//
// Environment:
//   RELEASE_API_BASE     e.g. https://ehk.itfarmer.in/api/v1
//   RELEASE_PUBLISH_TOKEN  the shared secret the server checks (X-Release-Token)
//
// The zip is built here rather than taken on trust, and its SHA-256 is computed over the exact bytes that
// are sent. The server recomputes it, and so does the phone before unpacking: one value, checked three
// times, which is what keeps "the app downloads and runs this" honest.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

// ---- zip, written here rather than shelled out to ------------------------------------------------
// `zip` does not exist on Windows, and a release that can only be cut from Linux is one that cannot be
// cut by hand when it matters. This also makes the archive deterministic -- fixed timestamps, sorted
// entries, so the same build always produces the same SHA-256, which is the value everything else checks.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function walk(root, base = root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

function makeZip(dir) {
  const names = walk(dir);
  if (!names.length) fail(`${dir} is empty`);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const raw = readFileSync(join(dir, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store when deflating does not help (already-compressed .bin models, .png, .wasm).
    const stored = deflated.length >= raw.length;
    const data = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);            // fixed mtime: deterministic archives
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const dirent = Buffer.alloc(46);
    dirent.writeUInt32LE(0x02014b50, 0);
    dirent.writeUInt16LE(20, 4);           // version made by
    dirent.writeUInt16LE(20, 6);           // version needed
    dirent.writeUInt16LE(0x0800, 8);
    dirent.writeUInt16LE(method, 10);
    dirent.writeUInt32LE(0, 12);
    dirent.writeUInt32LE(crc, 16);
    dirent.writeUInt32LE(data.length, 20);
    dirent.writeUInt32LE(raw.length, 24);
    dirent.writeUInt16LE(nameBuf.length, 28);
    dirent.writeUInt32LE(offset, 42);
    central.push(dirent, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return { zip: Buffer.concat([...locals, centralBuf, end]), count: names.length };
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

function fail(message) {
  console.error(`publish-bundle: ${message}`);
  process.exit(1);
}

const dir = arg('dir', 'dist');
const build = arg('build');
const minNative = arg('min-native', '0.0.0');
const notes = arg('notes', null);
const rollout = Number(arg('rollout', 100));
const channel = arg('channel', 'stable');
const release = arg('release', false) === true;

const base = (process.env.RELEASE_API_BASE ?? '').replace(/\/$/, '');
const token = process.env.RELEASE_PUBLISH_TOKEN;
if (!base) fail('RELEASE_API_BASE is not set');
if (!token) fail('RELEASE_PUBLISH_TOKEN is not set');
if (!build || !/^\d+$/.test(String(build))) fail('--build <n> is required (use the CI run number)');

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const gitSha = (process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD']).toString()).trim();
if (!/^[0-9a-f]{40}$/.test(gitSha)) fail(`cannot determine the commit (got "${gitSha}")`);

// The API base compiled into this bundle. It must be absolute: the WebView serves the app from
// https://localhost, so a bundle built with a relative /api/v1 would send every request at its own files.
// The server refuses such a bundle, but failing here says so before a 6 MB upload.
const apiBaseUrl = process.env.VITE_API_BASE_URL ?? '';
if (!/^https?:\/\//.test(apiBaseUrl)) {
  fail('VITE_API_BASE_URL must be the absolute server URL for an OTA bundle (the PWA build cannot be published)');
}

// Nothing is filtered out: the bundle replaces the whole served directory on the phone, so anything left
// out of it is simply gone -- including the 7 MB of face models and the SQLite WASM.
const { zip: body, count } = makeZip(dir);
const sha256 = createHash('sha256').update(body).digest('hex');
console.log(`bundle ${version}+${build}  ${count} files  ${(body.length / 1048576).toFixed(1)} MB  sha256 ${sha256.slice(0, 16)}…`);

async function post(path, { query = {}, json = null, raw = null }) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Release-Token': token,
      ...(raw ? { 'Content-Type': 'application/zip' } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ?? (json ? JSON.stringify(json) : undefined),
  });
  const text = await res.text();
  if (!res.ok) fail(`${path} -> HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const published = await post('/app/bundle', {
  query: {
    version, build, git_sha: gitSha, sha256,
    min_native_version: minNative, api_base_url: apiBaseUrl, notes,
  },
  raw: body,
});
console.log(`published: ${published.version}+${published.build} (${published.size_bytes} bytes)`);

if (!release) {
  console.log(`not released. To put it live:  POST ${base}/app/channel/${channel}  {"build": ${build}}`);
  process.exit(0);
}

const pointed = await post(`/app/channel/${channel}`, {
  json: { build: Number(build), rollout_percent: rollout, mandatory: false },
});
console.log(`channel ${channel} now serves ${pointed.bundle.version}+${pointed.bundle.build} at ${pointed.rollout_percent}%`);
if (pointed.rolled_back_from) console.log(`(rolled back from build ${pointed.rolled_back_from})`);
