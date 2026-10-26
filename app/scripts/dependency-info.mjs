import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function groupPackages(packages) {
  const grouped = new Map(packages.map((item) => [item.name, item]));
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function dependencyInfo() {
  const manifest = JSON.parse(read('../package.json'));
  const web = groupPackages([...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)].map((name) => ({
    name, url: `https://www.npmjs.com/package/${name}`,
  })));
  const packages = read('../../Cargo.lock').split('[[package]]').slice(1).map((entry) => {
    const name = entry.match(/^name = "([^"]+)"$/m)?.[1];
    const version = entry.match(/^version = "([^"]+)"$/m)?.[1];
    const source = entry.match(/^source = "([^"]+)"$/m)?.[1];
    if (!name || !version) throw new Error('Invalid Cargo.lock package');
    const dependencies = entry.match(/^dependencies = \[([\s\S]*?)^\]/m)?.[1] ?? '';
    return { name, version, source, dependencies: [...dependencies.matchAll(/^\s*"([^"]+)",?$/gm)].map((match) => match[1]) };
  });
  const byName = new Map();
  for (const item of packages) {
    const matches = byName.get(item.name) ?? [];
    matches.push(item);
    byName.set(item.name, matches);
  }
  function rustDependencies(...roots) {
    const visited = new Set();
    const items = [];
    function visit(reference) {
      const [name, version, source] = reference.split(' ');
      const matches = (byName.get(name) ?? []).filter((item) => (!version || item.version === version) && (!source || item.source === source.slice(1, -1)));
      if (matches.length !== 1) throw new Error(`Cannot resolve Cargo.lock dependency: ${reference}`);
      const item = matches[0];
      if (visited.has(item)) return;
      visited.add(item);
      if (item.source) items.push({ name: item.name, url: `https://crates.io/crates/${item.name}` });
      item.dependencies.forEach(visit);
    }
    roots.forEach(visit);
    return groupPackages(items);
  }
  const android = groupPackages([...read('../src-tauri/gen/android/app/build.gradle.kts').matchAll(/implementation\("([^:"]+):([^:"]+):([^"]+)"\)/g)].map(([, group, artifact, version]) => ({
    name: `${group}:${artifact}`,
    url: group.startsWith('androidx.') || group.startsWith('com.google.')
      ? `https://maven.google.com/web/index.html#${group}:${artifact}:${version}`
      : `https://central.sonatype.com/artifact/${group}/${artifact}/${version}`,
  })));
  if (!web.length || !packages.length || !android.length) throw new Error('Dependency information is empty');
  return [
    { id: 'web', title: '웹', items: web },
    { id: 'app', title: '앱', items: rustDependencies('hongsi-app', 'hongsi-ios-widget') },
    { id: 'server', title: '서버', items: rustDependencies('hongsi-server') },
    { id: 'android', title: 'Android', items: android },
  ];
}

export function dependencyModule() {
  const entries = [];
  const indexes = new Map();
  const groups = dependencyInfo().map((group) => ({
    ...group,
    items: group.items.map((item) => {
      if (!indexes.has(item.url)) {
        indexes.set(item.url, entries.length);
        entries.push(item);
      }
      return indexes.get(item.url);
    }),
  }));
  return `const entries=${JSON.stringify(entries)};export default ${JSON.stringify(groups)}.map(({items,...group})=>({...group,items:items.map(index=>entries[index])}));`;
}
