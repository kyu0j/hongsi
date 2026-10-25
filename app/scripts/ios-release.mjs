import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repositoryName } from './public-env.mjs';
import { assetStem } from './release-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apple = join(root, 'app/src-tauri/gen/apple');
const targets = { Hongsi: 'dev.kyuyoung.hongsi', HongsiWidgets: 'dev.kyuyoung.hongsi.widgets' };
const group = 'group.dev.kyuyoung.hongsi';
const sharedKeychain = 'dev.kyuyoung.hongsi.shared';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'unavailable'}).`);
  return result.stdout?.trim() ?? '';
}
function paths() {
  const temp = resolve(required('RUNNER_TEMP'), 'hongsi-ios-signing');
  return { temp, state: join(temp, 'state.json'), spec: join(apple, '.ci-project.json') };
}
async function plist(path, value) {
  const json = `${path}.json`;
  await writeFile(json, JSON.stringify(value), { mode: 0o600 });
  try { run('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, json]); }
  finally { await rm(json, { force: true }); }
}
function extract(path, key, format = 'raw') {
  return run('/usr/bin/plutil', ['-extract', key, format, '-o', '-', path]);
}
async function decodeSecret(name, destination) {
  const source = required(name).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(source) || source.length % 4 !== 0) throw new Error(`${name} must be base64.`);
  const data = Buffer.from(source, 'base64');
  if (!data.length) throw new Error(`${name} is empty.`);
  await writeFile(destination, data, { mode: 0o600 });
}
async function profile(name, id, temp) {
  const path = join(temp, `${name}.mobileprovision`);
  const decoded = join(temp, `${name}.plist`);
  await decodeSecret(name, path);
  run('/usr/bin/security', ['cms', '-D', '-i', path, '-o', decoded]);
  const entitlements = JSON.parse(extract(decoded, 'Entitlements', 'json'));
  const platforms = JSON.parse(extract(decoded, 'Platform', 'json'));
  if (!Array.isArray(platforms) || !platforms.includes('iOS')) throw new Error(`${name} must be an iOS profile.`);
  const teams = JSON.parse(extract(decoded, 'TeamIdentifier', 'json'));
  const prefixes = JSON.parse(extract(decoded, 'ApplicationIdentifierPrefix', 'json'));
  const uuid = extract(decoded, 'UUID');
  const expiry = Date.parse(extract(decoded, 'ExpirationDate'));
  const devices = spawnSync('/usr/bin/plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', decoded], { stdio: 'ignore' });
  const enterprise = spawnSync('/usr/bin/plutil', ['-extract', 'ProvisionsAllDevices', 'raw', '-o', '-', decoded], { encoding: 'utf8' });
  if (!/^[0-9A-F-]{36}$/i.test(uuid) || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error(`${name} is invalid or expired.`);
  if (teams.length !== 1 || prefixes.length !== 1 || !/^[A-Z0-9]{10}$/.test(teams[0]) || !/^[A-Z0-9]{10}$/.test(prefixes[0])) throw new Error(`${name} has an invalid team.`);
  if (devices.status === 0 || enterprise.stdout?.trim() === 'true' || entitlements['get-task-allow'] !== false) throw new Error(`${name} must be an App Store profile.`);
  if (entitlements['application-identifier'] !== `${prefixes[0]}.${id}` || entitlements['com.apple.developer.team-identifier'] !== teams[0]) throw new Error(`${name} does not match the app identifier.`);
  if (!entitlements['com.apple.security.application-groups']?.includes(group)) throw new Error(`${name} is missing the shared App Group.`);
  const keychain = `${prefixes[0]}.${sharedKeychain}`;
  if (!entitlements['keychain-access-groups']?.some(value => value === keychain || value === `${prefixes[0]}.*`)) throw new Error(`${name} is missing shared Keychain access.`);
  if (id === targets.Hongsi && entitlements['aps-environment'] !== 'production') throw new Error(`${name} requires production Push Notifications.`);
  const certificates = [];
  for (let index = 0; ; index++) {
    const result = spawnSync('/usr/bin/plutil', ['-extract', `DeveloperCertificates.${index}`, 'raw', '-o', '-', decoded], { encoding: 'utf8' });
    if (result.status !== 0) break;
    certificates.push(createHash('sha1').update(Buffer.from(result.stdout.trim(), 'base64')).digest('hex').toUpperCase());
  }
  if (!certificates.length) throw new Error(`${name} has no signing certificates.`);
  return { path, uuid, team: teams[0], prefix: prefixes[0], certificates };
}

async function prepareSigning() {
  for (const key of ['IOS_CERTIFICATE_BASE64', 'IOS_CERTIFICATE_PASSWORD', 'IOS_APP_PROFILE_BASE64', 'IOS_WIDGET_PROFILE_BASE64']) required(key);
  const { temp, state } = paths();
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const searchList = [...run('/usr/bin/security', ['list-keychains', '-d', 'user']).matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const signing = { keychain: join(temp, 'signing.keychain-db'), searchList, installedProfiles: [], targets: {} };
  const save = () => writeFile(state, JSON.stringify(signing), { mode: 0o600 });
  await writeFile(state, JSON.stringify(signing), { flag: 'wx', mode: 0o600 });
  const app = await profile('IOS_APP_PROFILE_BASE64', targets.Hongsi, temp);
  const widget = await profile('IOS_WIDGET_PROFILE_BASE64', targets.HongsiWidgets, temp);
  if (app.team !== widget.team || app.prefix !== widget.prefix) throw new Error('App and widget profiles must belong to the same team and prefix.');
  const password = randomBytes(32).toString('base64');
  const certificate = join(temp, 'distribution.p12');
  await decodeSecret('IOS_CERTIFICATE_BASE64', certificate);
  try {
    run('/usr/bin/security', ['create-keychain', '-p', password, signing.keychain]);
    run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', signing.keychain]);
    run('/usr/bin/security', ['unlock-keychain', '-p', password, signing.keychain]);
    run('/usr/bin/security', ['import', certificate, '-P', required('IOS_CERTIFICATE_PASSWORD'), '-k', signing.keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
    run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, signing.keychain]);
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', signing.keychain, ...searchList]);
  } finally { await rm(certificate, { force: true }); }
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', signing.keychain]);
  const valid = [...identities.matchAll(/\b([A-F0-9]{40})\s+"(?:Apple Distribution|iPhone Distribution):/g)].map(match => match[1]);
  const identity = app.certificates.find(value => widget.certificates.includes(value) && valid.includes(value));
  if (!identity) throw new Error('The distribution certificate must be valid and included in both profiles.');
  signing.identity = identity;
  signing.team = app.team;
  const directory = join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles');
  await mkdir(directory, { recursive: true });
  for (const [target, value] of [['Hongsi', app], ['HongsiWidgets', widget]]) {
    const destination = join(directory, `${value.uuid}.mobileprovision`);
    await copyFile(value.path, destination, 1);
    signing.installedProfiles.push(destination);
    signing.targets[target] = value.uuid;
    await save();
  }
  console.log('App Store signing configuration is ready.');
}

async function cleanup() {
  const { temp, state, spec } = paths();
  let signing;
  try { signing = JSON.parse(await readFile(state, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    if (signing) run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...signing.searchList]);
  } finally {
    if (signing) {
      for (const path of signing.installedProfiles) await rm(path, { force: true });
      spawnSync('/usr/bin/security', ['delete-keychain', signing.keychain], { stdio: 'ignore' });
    }
    await rm(temp, { recursive: true, force: true });
    const generated = await stat(spec).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    await rm(spec, { force: true });
    if (generated) run('xcodegen', ['generate', '--spec', join(apple, 'project.yml')], { cwd: apple });
  }
}

function buildNumber(runValue, attemptValue) {
  const run = Number(runValue), attempt = Number(attemptValue);
  if (!Number.isSafeInteger(run) || run < 1 || run > 999899 || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 99) throw new Error('Invalid iOS build number.');
  return `${Math.floor(run / 100) + 1}.${run % 100}.${attempt}`;
}

function projectSpec(signing, version, number) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('A numeric iOS marketing version is required.');
  const overlay = { include: ['project.yml'], settings: { base: { MARKETING_VERSION: version, CURRENT_PROJECT_VERSION: number } }, targets: {} };
  for (const target of Object.keys(targets)) overlay.targets[target] = { settings: { configs: { Release: {
    CODE_SIGN_STYLE: 'Manual', DEVELOPMENT_TEAM: signing.team, CODE_SIGN_IDENTITY: signing.identity,
    PROVISIONING_PROFILE_SPECIFIER: signing.targets[target], OTHER_CODE_SIGN_FLAGS: `--keychain "${signing.keychain}"`,
  } } } };
  return overlay;
}

function exportOptions(signing) {
  return { method: 'app-store-connect', destination: 'export', signingStyle: 'manual', teamID: signing.team,
    signingCertificate: signing.identity, manageAppVersionAndBuildNumber: false,
    provisioningProfiles: Object.fromEntries(Object.entries(targets).map(([target, id]) => [id, signing.targets[target]])),
    stripSwiftSymbols: true, uploadSymbols: false };
}

async function build() {
  const { temp, state, spec } = paths();
  const signing = JSON.parse(await readFile(state, 'utf8'));
  const pkg = JSON.parse(await readFile(join(root, 'app/package.json'), 'utf8'));
  const number = buildNumber(required('GITHUB_RUN_NUMBER'), required('GITHUB_RUN_ATTEMPT'));
  const stem = required('HONGSI_RELEASE_ASSET_STEM');
  if (!/^hongsi-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem)) throw new Error('Invalid release asset name.');
  await writeFile(spec, JSON.stringify(projectSpec(signing, pkg.version, number)), { flag: 'wx' });
  run('xcodegen', ['generate', '--spec', spec], { cwd: apple, stdio: 'inherit' });
  const archive = join(root, 'target/ios-appstore/Hongsi.xcarchive');
  run('/usr/bin/xcodebuild', ['-project', join(apple, 'Hongsi.xcodeproj'), '-scheme', 'Hongsi', '-configuration', 'Release',
    '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-derivedDataPath', join(root, 'target/ios-xcode'),
    '-archivePath', archive, 'ARCHS=arm64', 'archive'], { cwd: join(root, 'app'), stdio: 'inherit' });
  const app = join(archive, 'Products/Applications/Hongsi.app');
  for (const [target, bundle] of [['Hongsi', app], ['HongsiWidgets', join(app, 'PlugIns/HongsiWidgets.appex')]]) {
    const info = join(bundle, 'Info.plist');
    if (extract(info, 'CFBundleIdentifier') !== targets[target] || extract(info, 'CFBundleShortVersionString') !== pkg.version || extract(info, 'CFBundleVersion') !== number) throw new Error('App and widget version metadata do not match.');
    run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
  }
  const options = join(temp, 'ExportOptions.plist');
  await plist(options, exportOptions(signing));
  const exported = join(temp, 'export');
  run('/usr/bin/xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', options, '-exportPath', exported], { stdio: 'inherit' });
  const files = (await readdir(exported)).filter(name => name.endsWith('.ipa'));
  if (files.length !== 1) throw new Error('Expected one App Store IPA.');
  const output = resolve(required('RUNNER_TEMP'), 'hongsi-ios-release');
  await mkdir(output, { recursive: true });
  const ipa = join(output, `${stem}-ios-appstore.ipa`);
  await copyFile(join(exported, files[0]), ipa);
  run('/usr/bin/unzip', ['-tq', ipa]);
  console.log(`Packaged ${stem}-ios-appstore.ipa (${pkg.version}, build ${number}).`);
}

async function publish(directory) {
  const repository = repositoryName(), tag = required('RELEASE_TAG');
  const prerelease = process.env.RELEASE_PRERELEASE === 'true';
  const name = `${assetStem(tag, prerelease)}-ios-appstore.ipa`;
  const file = resolve(directory, name);
  const release = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`]));
  if (release.tag_name !== tag || release.draft || release.prerelease !== prerelease || !release.published_at) throw new Error('Release is not published or its type changed.');
  const data = await readFile(file), digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.state !== 'uploaded' || existing.size !== data.length || existing.digest?.toLowerCase() !== digest) throw new Error(`Existing ${name} differs. Publish a new version.`);
  } else run('gh', ['release', 'upload', '--repo', repository, '--', tag, file], { stdio: 'inherit' });
  console.log(`Uploaded ${name}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, value] = process.argv.slice(2);
    if (command === 'prepare-signing') await prepareSigning();
    else if (command === 'build') await build();
    else if (command === 'cleanup') await cleanup();
    else if (command === 'publish' && value) await publish(value);
    else throw new Error('Usage: ios-release.mjs prepare-signing|build|cleanup|publish DIRECTORY');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'iOS release failed.');
    process.exitCode = 1;
  }
}
