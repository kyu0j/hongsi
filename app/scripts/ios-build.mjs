import { spawnSync } from 'node:child_process';
import { machine } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: app, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated (${result.signal}).`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  const mode = process.argv[2] || 'simulator';
  const args = ['-project', 'src-tauri/gen/apple/Hongsi.xcodeproj', '-scheme', 'Hongsi',
    '-derivedDataPath', resolve(app, '../target/ios-xcode')];
  let action = 'build';
  switch (mode) {
    case 'simulator':
      args.push('-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination',
        'generic/platform=iOS Simulator', `ARCHS=${machine()}`, 'CODE_SIGN_IDENTITY=-');
      break;
    case 'device':
    case 'personal':
      args.push('-configuration', 'Personal', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS');
      break;
    case 'archive':
      args.push('-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS',
        '-archivePath', resolve(app, '../target/ios/Hongsi.xcarchive'));
      action = 'archive';
      break;
    default:
      throw new Error('Usage: ios-build.mjs simulator|device|personal|archive [xcodebuild settings]');
  }
  run('pnpm', ['build']);
  run('xcodegen', ['generate', '--spec', 'src-tauri/gen/apple/project.yml']);
  run('xcodebuild', [...args, ...process.argv.slice(3), action]);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'iOS build failed.');
  process.exitCode = 1;
}
