import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const groups = JSON.parse(readFileSync(resolve(root, 'crates/config/url-keys.json'), 'utf8'));

function configuredUrls(keys, environment = process.env) {
  const values = {};
  for (const file of ['.env.example', '.env', '.env.server']) {
    let parsed;
    try { parsed = parseEnv(readFileSync(resolve(root, file), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error(`${file} 파일을 읽을 수 없습니다.`); }
    for (const key of keys) if (parsed[key]?.trim()) values[key] = parsed[key];
  }
  for (const key of keys) {
    const value = (environment[key]?.trim() || values[key] || '').trim().replace(/\/+$/, '');
    let url;
    try { url = new URL(value); } catch { throw new Error(`${key} 주소 형식이 잘못되었습니다.`); }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /\s/.test(value)) {
      throw new Error(`${key} 주소 형식이 잘못되었습니다.`);
    }
    values[key] = value;
  }
  return values;
}

export function publicUrls(environment = process.env) {
  const values = configuredUrls(groups.public, environment);
  repositoryName(values.HONGSI_REPO_URL);
  return values;
}

export function repositoryName(value = configuredUrls(['HONGSI_REPO_URL']).HONGSI_REPO_URL) {
  const url = new URL(value);
  const repository = url.pathname.replace(/^\/|\/$/g, '');
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
      || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) {
    throw new Error('HONGSI_REPO_URL에는 GitHub 저장소 주소가 필요합니다.');
  }
  return repository;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--check-build') {
      const values = configuredUrls([...groups.public, ...groups.server]);
      repositoryName(values.HONGSI_REPO_URL);
      console.log('Build configuration is ready.');
    } else {
      const urls = publicUrls();
      if (process.argv[2] === '--android-update') process.stdout.write(JSON.stringify(`${urls.HONGSI_API_URL}/api/app-update`));
      else if (process.argv[2] === '--api') process.stdout.write(urls.HONGSI_API_URL);
      else throw new Error('공개 주소 출력 옵션이 필요합니다.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : '빌드 주소 설정을 확인해 주세요.');
    process.exitCode = 1;
  }
}
