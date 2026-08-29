/**
 * Ship the working tree to Apify as a new actor version, then build it.
 *
 * Why this is committed rather than improvised: the first release was pushed
 * from a throwaway script in a temp directory, which was cleaned up — so the
 * next person needing to deploy had to reconstruct the payload format from
 * memory. Deployment is part of the actor, so it lives with the actor.
 *
 * Auth goes through the Composio proxy, which holds the Apify account, so no
 * token is ever read or printed here.
 *
 *   node scripts/push.mjs            # push sources + build
 *   node scripts/push.mjs --dry-run  # print what would be sent
 *
 * The version number comes from `.actor/actor.json`; the build tag from the
 * same file. Apify replaces the whole source file list on a PUT, so anything
 * missing from FILES below simply stops existing in the built image.
 */
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTOR_ID = process.env.APIFY_ACTOR_ID ?? 'V9RNB29i6pJEAvyiR';
const DRY = process.argv.includes('--dry-run');

/** Directories whose whole contents ship, plus the loose files at the root.
 *  `node_modules` is deliberately absent: the Dockerfile runs `npm install`. */
const DIRS = ['src', 'scripts', '.actor', 'tests'];
const ROOT_FILES = ['package.json', 'package-lock.json', 'Dockerfile', 'README.md', 'CHANGELOG.md', '.dockerignore'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    const abs = join(ROOT, rel);
    if (statSync(abs).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const paths = [...ROOT_FILES, ...DIRS.flatMap(walk)]
  .map((p) => relative(ROOT, join(ROOT, p)).split('\\').join('/'))
  .sort();

const sourceFiles = paths.map((name) => ({
  name,
  format: 'TEXT',
  content: readFileSync(join(ROOT, name), 'utf8'),
}));

const actorJson = JSON.parse(readFileSync(join(ROOT, '.actor/actor.json'), 'utf8'));
const version = actorJson.version;
const buildTag = actorJson.buildTag ?? 'latest';

const bytes = sourceFiles.reduce((n, f) => n + f.content.length, 0);
console.log(`${sourceFiles.length} files, ${(bytes / 1024).toFixed(0)} KB -> actor ${ACTOR_ID} version ${version} (${buildTag})`);
if (DRY) {
  for (const f of sourceFiles) console.log(`  ${f.name}`);
  process.exit(0);
}

/** One Composio proxy call. The body goes through stdin so a large payload
 *  never has to survive an argv length limit. */
async function apify(url, { method = 'GET', body = null } = {}) {
  const args = ['proxy', url, '--toolkit', 'apify', '-X', method];
  if (body !== null) args.push('-H', 'content-type: application/json', '-d', '-');
  const { stdout } = await run('composio', args, {
    input: body === null ? undefined : JSON.stringify(body),
    maxBuffer: 256 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Apify did not answer with JSON: ${stdout.slice(0, 400)}`);
  }
}

const put = await apify(`https://api.apify.com/v2/acts/${ACTOR_ID}/versions/${version}`, {
  method: 'PUT',
  body: { versionNumber: version, buildTag, sourceType: 'SOURCE_FILES', sourceFiles },
});
if (put.error) throw new Error(`version PUT failed: ${JSON.stringify(put.error)}`);
console.log(`version ${version} updated`);

const build = await apify(
  `https://api.apify.com/v2/acts/${ACTOR_ID}/builds?version=${version}&tag=${buildTag}&waitForFinish=120`,
  { method: 'POST' },
);
const data = build.data ?? build;
if (build.error) throw new Error(`build POST failed: ${JSON.stringify(build.error)}`);
console.log(`build ${data.buildNumber} -> ${data.status}`);
if (data.status !== 'SUCCEEDED') {
  console.error(`Build did not succeed. Log: https://console.apify.com/actors/${ACTOR_ID}/builds/${data.buildNumber}`);
  process.exit(1);
}
