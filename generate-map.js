
const fs = require('fs');
const url = require('url');
const https = require('https');
const stream = require('stream');

const tar = require('tar');

const GITHUB_URL = 'https://api.github.com/emojis';
const PACKAGE_NAME = 'unicode-emoji';
const PACKAGE_FILE = 'package/unicode-emoji.js';
const PACKAGE_EXTRACT = /^export default (\{.*\});$/;
const OUTPUT_FILENAME = 'emoji-annotation-to-unicode.js';

const UNICODE_OVERRIDES = {
  '23-fe0f-20e3': 'keycap: hash',
  '2a-fe0f-20e3': 'keycap: asterisk',
};

const SKIN_TONES = {
  '1f3fb': 'light_skin_tone',
  '1f3fc': 'medium-light_skin_tone',
  '1f3fd': 'medium_skin_tone',
  '1f3fe': 'medium-dark_skin_tone',
  '1f3ff': 'dark_skin_tone',
};

function getURL(url, text = true) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers: {'User-Agent': 'nodejs'}}, (resp) => {
      const accum = [];
      if (text) resp.setEncoding('utf-8');
      resp.on('data', (chunk) => accum.push(chunk));
      resp.on('end', () => {
        if (text) {
          resolve(accum.join(''));
        } else {
          resolve(Buffer.concat(accum));
        }
      });
      resp.on('error', reject);
    }).on('error', reject);
  });
}

function extractTarMember(archiveStream, fileName) {
  return new Promise((resolve, reject) => {
    let found = false;
    archiveStream.pipe(new tar.Parser({
      strict: true,
      filter: (path, entry) => {
        if (path != fileName) return false;
        found = true;
        return true;
      },
      onentry: (entry) => {
        const accum = [];
        entry.on('data', (chunk) => accum.push(chunk));
        entry.on('end', () => resolve(Buffer.concat(accum)));
      },
      ondone: () => {
        if (!found) reject(new Error('Member ' + fileName +
                                     ' not found in tar archive'));
      }
    }));
  });
}

async function getPackageFile(packageName, fileName) {
  const pkgInfo = JSON.parse(await getURL('https://registry.npmjs.org/' +
                                          packageName));
  const latestInfo = pkgInfo.versions[pkgInfo['dist-tags'].latest];
  const pkgData = await getURL(latestInfo.dist.tarball, false);
  return await extractTarMember(stream.Readable.from(pkgData), fileName);
}

function evalPackageData(code) {
  // Newer versions of unicode-emoji no longer use JSON syntax in the main
  // data object, so eval it is!
  return (0, eval)(`'use strict'; (${code})`);
}

async function getGithubData() {
  const githubRawData = JSON.parse(await getURL(GITHUB_URL));

  const githubData = {};
  for (const key of Object.keys(githubRawData)) {
    const m = /\/unicode\/(.+?)\.png/.exec(githubRawData[key]);
    if (!m) continue;
    githubData[key] = m[1].replace(/(^|-)0+/g, '$1');
  }

  return githubData;
}

async function getUnicodeData() {
  function stringToCodepoints(s) {
    return [...s].map(c => c.codePointAt(0).toString(16)).join('-');
  }

  function processEmoji(entry) {
    const cps = stringToCodepoints(entry.emoji);
    let name = UNICODE_OVERRIDES[cps] || entry.description;
    name = name.toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/[ -]/g, '_');
    if (result[name])
      throw new Error(`Ambiguous Unicode emoji name ${name}: ` +
                      `${result[name]} <-> ${cps}`);
    result[name] = cps;

    if (entry.variations) entry.variations.forEach(processEmoji);
  }

  const rawData = await getPackageFile(PACKAGE_NAME, PACKAGE_FILE);
  const m = PACKAGE_EXTRACT.exec(rawData.toString());
  if (!m) throw new Error('Could not extract emoji data');
  const data = evalPackageData(m[1]);

  const result = {};
  data.emojis.forEach(processEmoji);
  return result;
}

async function main() {
  const githubData = await getGithubData();
  const unicodeData = await getUnicodeData();

  const githubToUnicode = {};
  for (const v of Object.values(unicodeData)) {
    const rv = v.replace(/-(200d|fe0f)(?=-|$)/g, '');
    if (/(^|-)(200d|fe0f)(-|$)/.test(rv))
      throw new Error(`Leftover ZWJ or VS15 in emoji ${rv} (${v})`);
    if (githubToUnicode[rv])
      throw new Error(`Ambiguous Unicode emoji?! ${githubToUnicode[rv]} ` +
                      `<-> ${v}`);
    githubToUnicode[rv] = v;
  }

  const result = {}, codepointsSeen = {};
  for (const [name, cps] of Object.entries(githubData)) {
    if (!githubToUnicode[cps])
      throw new Error(`GitHub emoji ${name} (${cps}) has no Unicode ` +
                      `equivalent!`);
    const realCPs = githubToUnicode[cps];
    result[name] = realCPs;
    codepointsSeen[realCPs] = true;
  }

  for (const [name, cps] of Object.entries(unicodeData)) {
    if (codepointsSeen[cps]) continue;
    result[name] = cps;
  }

 Object.assign(result, require('./aliases'));
  
  const text = `module.exports = ${JSON.stringify(result, null, 2)};\n`;
  fs.writeFileSync(OUTPUT_FILENAME, text);
}

main();
