import { copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function alignedElf(bytes, name) {
  if (bytes.length < 52 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || ![1, 2].includes(bytes[4]) || ![1, 2].includes(bytes[5])) throw new Error(`Invalid ELF: ${name}`);
  const wide = bytes[4] === 2;
  const little = bytes[5] === 1;
  const read = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error(`Truncated ELF: ${name}`);
    const value = size === 8
      ? Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset))
      : little ? bytes.readUIntLE(offset, size) : bytes.readUIntBE(offset, size);
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid ELF offset: ${name}`);
    return value;
  };
  const offset = read(wide ? 32 : 28, wide ? 8 : 4);
  const stride = read(wide ? 54 : 42, 2);
  const count = read(wide ? 56 : 44, 2);
  if (!count || stride < (wide ? 56 : 32) || offset + stride * count > bytes.length) throw new Error(`Invalid ELF headers: ${name}`);
  let loads = 0;
  for (let i = 0; i < count; i++) {
    const pos = offset + i * stride;
    if (read(pos, 4) !== 1) continue;
    loads++;
    const alignment = read(pos + (wide ? 48 : 28), wide ? 8 : 4);
    if (alignment < 16384) throw new Error(`${name}: PT_LOAD alignment ${alignment} is below 16 KB`);
  }
  if (!loads) throw new Error(`${name}: no PT_LOAD headers`);
}

async function packagePlayBundle({ aab, output, stem }) {
  if (!/^hongsi-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem ?? '')) throw new Error('HONGSI_RELEASE_ASSET_STEM is required.');
  const file = resolve(aab);
  execFileSync('jarsigner', ['-verify', file], { stdio: 'inherit' });
  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (!names.some(name => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/.test(name))) throw new Error('Unsigned bundle.');
  const entry = name => execFileSync('unzip', ['-p', file, name], { maxBuffer: 256 * 1024 * 1024 });
  const manifest = entry('base/manifest/AndroidManifest.xml');
  if (manifest.includes('REQUEST_INSTALL_PACKAGES')) throw new Error('Play bundle contains APK install permission.');
  if (manifest.includes('UpdateInstallReceiver')) throw new Error('Play bundle contains APK installer.');
  const libraries = names.filter(name => name.startsWith('base/lib/') && name.endsWith('.so'));
  if (!libraries.some(name => name.startsWith('base/lib/arm64-v8a/'))) throw new Error('Missing 64-bit native libraries.');
  for (const name of libraries) alignedElf(entry(name), name);
  const dir = resolve(output, 'android');
  await mkdir(dir, { recursive: true });
  await copyFile(file, resolve(dir, `${stem}.aab`));
  console.log(`Play bundle verified: no APK installer permission; ${libraries.length} aligned native libraries.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [aab, output] = process.argv.slice(2);
    if (!aab || !output) throw new Error('Usage: package-google-play.mjs AAB OUTPUT_DIRECTORY');
    await packagePlayBundle({ aab, output, stem: process.env.HONGSI_RELEASE_ASSET_STEM });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Play bundle verification failed.');
    process.exitCode = 1;
  }
}
