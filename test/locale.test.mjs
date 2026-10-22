/**
 * Display-metadata tests: the English/Chinese plugin title and description that
 * the Plugins page shows, selected by DSH's active locale.
 *
 * DSH reads these from `locale/<language>.json` inside the package, through the
 * same reader the inventory uses (`readPluginMeta` in
 * `@deepseek-ai/dsh-app-boot`), and the client resolves the resulting map with
 * `locale.resolveText()`, which walks the active language's fallback chain
 * (`zh` → `en`). Two consequences the suite pins down, because neither is
 * visible from the source tree alone:
 *
 *   - **`locale/en.json` gates every other dictionary.** The reader finds the
 *     locale directory by resolving `<specifier>/locale/en.json` first and then
 *     scanning that directory, so a missing English baseline silently discards
 *     the Chinese one.
 *   - **`exports` and `files[]` decide whether the metadata exists at all.**
 *     Resources are resolved through Node's exports map, and only `files[]`
 *     reaches the published tarball; both are asserted here rather than trusted.
 *
 * The final test calls DSH's real reader, so the assertions are on DSH's answer,
 * not on a reimplementation of its rules.
 *
 * @module dsh-opencode-session-header/test/locale
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dshPackageFile, resolveDshRoot } from './dsh-root.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const localeDir = join(root, 'locale');

/** DSH's own rule for a locale file name (`LANGUAGE_ID` in dsh-app-boot). */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** Read one locale dictionary. */
const dictionary = (language) => JSON.parse(readFileSync(join(localeDir, `${language}.json`), 'utf8'));

test('the locale directory follows DSH display-metadata format', () => {
  const files = readdirSync(localeDir).filter((name) => name.endsWith('.json'));
  assert.deepEqual(files.sort(), ['en.json', 'zh.json'], 'English baseline plus the Chinese dictionary');
  for (const file of files) {
    assert.match(file.slice(0, -5), LANGUAGE_ID, `${file} must be named after a language id`);
  }
  for (const language of ['en', 'zh']) {
    const parsed = dictionary(language);
    assert.equal(typeof parsed.meta, 'object', `${language}.json carries a meta object`);
    assert.equal(typeof parsed.meta.title, 'string', `${language}.json meta.title`);
    assert.notEqual(parsed.meta.title.trim(), '', `${language}.json meta.title must not be blank`);
    // Both languages carry their own display description. Leaving English to the
    // package.json fallback is what made the two languages asymmetric before: the
    // Chinese card got a curated sentence, the English one the npm blurb.
    assert.equal(typeof parsed.meta.description, 'string', `${language}.json must describe the plugin itself`);
    assert.notEqual(parsed.meta.description.trim(), '', `${language}.json meta.description must not be blank`);
  }
  assert.notEqual(dictionary('en').meta.title, dictionary('zh').meta.title, 'the two titles really differ');
  assert.notEqual(dictionary('en').meta.description, dictionary('zh').meta.description, 'and so do the two descriptions');
  assert.notEqual(dictionary('en').meta.title, pkg.name, 'the English title is a display name, not the package id');
});

test('the package exports the locale resources and ships them', () => {
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json', 'the reader resolves through the exports map');
  assert.equal(pkg.files.includes('locale/*.json'), true, 'only files[] reaches the published tarball');
  for (const required of ['.', './session-header', './cordis.patch.yml', './package.json']) {
    assert.notEqual(pkg.exports[required], undefined, `${required} stays exported`);
  }
});

test('the icon follows the house style and is reachable', () => {
  assert.equal(pkg.exports['./icon'], './icon.svg', "DSH reads a package's icon from the exported ./icon");
  assert.equal(pkg.files.includes('icon.svg'), true, 'and only files[] reaches the published tarball');

  const source = readFileSync(join(root, 'icon.svg'), 'utf8');
  assert.match(source, /viewBox="0 0 36 36"/, 'every shipped plugin icon uses a 36×36 canvas');
  assert.match(source, /linearGradient/, 'and the house gradient');
  assert.match(source, /#6DB9FB/, 'from the family palette');
  assert.match(source, /#3650DE/);
  assert.equal(statSync(join(root, 'icon.svg')).size < 256 * 1024, true, 'the reader caps an icon at 256 KiB');
});

test("DSH's own reader resolves the dictionaries into an en + zh map", async () => {
  const dshRoot = resolveDshRoot();
  const { readPluginMeta } = await import(pathToFileURL(dshPackageFile(dshRoot, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
  const meta = readPluginMeta(pkg.name, pathToFileURL(join(root, 'package.json')).href);

  assert.equal(meta.error, undefined, `the reader reported ${meta.error}`);
  assert.deepEqual(meta.title, { en: dictionary('en').meta.title, zh: dictionary('zh').meta.title });
  assert.deepEqual(meta.description, {
    en: dictionary('en').meta.description,
    zh: dictionary('zh').meta.description,
  }, 'both languages show their own curated description, not the package fallback');
  assert.notEqual(meta.description.en, pkg.description, 'the English card text is not the npm blurb');
  assert.equal(JSON.parse(JSON.stringify(meta)).title.zh, dictionary('zh').meta.title, 'the map survives the transport to the client');
  assert.match(meta.icon ?? '', /^data:image\/svg\+xml;base64,/, 'the icon arrives as a data URL the page can render');
  assert.equal(meta.icon, `data:image/svg+xml;base64,${readFileSync(join(root, 'icon.svg')).toString('base64')}`, 'and it is this package\'s icon, byte for byte');
});

test('without locale/en.json the reader discards every other dictionary', async (t) => {
  const dshRoot = resolveDshRoot();
  const { readPluginMeta } = await import(pathToFileURL(dshPackageFile(dshRoot, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
  const scratch = join(here, 'tmp', 'no-english-baseline');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  cpSync(join(root, 'package.json'), join(scratch, 'package.json'));
  mkdirSync(join(scratch, 'locale'));
  cpSync(join(localeDir, 'zh.json'), join(scratch, 'locale', 'zh.json'));

  const meta = readPluginMeta(pkg.name, pathToFileURL(join(scratch, 'package.json')).href);
  assert.equal(typeof meta.title, 'string', 'with no English baseline the title degrades to a plain fallback');
  assert.equal(meta.title, pkg.name, 'and that fallback is the package name');
  assert.equal(meta.description, pkg.description, 'the Chinese dictionary was never read');
});
