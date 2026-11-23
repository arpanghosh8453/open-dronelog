#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const contextDir = path.join(root, 'context');
const generatedDir = path.join(contextDir, 'generated');
const linksDir = path.join(contextDir, 'links');

function readText(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function readJson(relPath) {
  return JSON.parse(readText(relPath));
}

function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseCargoDependencies(cargoToml) {
  const lines = cargoToml.split(/\r?\n/);
  const deps = [];
  let inDependencies = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[')) {
      inDependencies = trimmed === '[dependencies]';
      continue;
    }

    if (!inDependencies || !trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name) deps.push(name);
  }

  return uniqueSorted(deps);
}

function parseRoutes(serverRs) {
  const routes = [];
  // rustfmt splits longer route declarations across lines. Parse the whole router chain
  // so the generated API inventory does not silently lose those endpoints.
  const start = serverRs.indexOf('Router::new()');
  if (start < 0) return routes;
  const end = serverRs.indexOf('.layer(cors)', start);
  const block = serverRs.slice(start, end < 0 ? undefined : end);
  const declarations = block.matchAll(/\.route\(\s*"([^"]+)"\s*,([\s\S]*?)(?=\.route\(|\.layer\(|$)/g);
  for (const [, routePath, expr] of declarations) {
    for (const match of expr.matchAll(/\b(get|post|put|delete|patch)\s*\(\s*([a-zA-Z0-9_]+)/g)) {
      routes.push({ path: routePath, method: match[1].toUpperCase(), handler: match[2] });
    }
  }

  return routes;
}

function parseTauriCommands(apiTs) {
  return uniqueSorted(
    [...apiTs.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]),
  );
}

function parseEnvVarsFromCompose(composeText) {
  return [...composeText.matchAll(/-\s*([A-Z][A-Z0-9_]+)=/g)].map((m) => m[1]);
}

function parseEnvVarsFromReadme(readmeText) {
  return [...readmeText.matchAll(/\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/g)].map((m) => m[1]);
}

function parseTables(databaseRs) {
  const tables = [];
  const tableRegex = /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^;]+?)\)\s*;/gms;

  for (const match of databaseRs.matchAll(tableRegex)) {
    const tableName = match[1];
    const body = match[2];
    const columns = [];

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.split('--')[0].trim().replace(/,$/, '').trim();
      if (!line) continue;
      if (/^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT)\b/i.test(line)) continue;

      const colMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+(.+)$/);
      if (!colMatch) continue;

      columns.push({
        name: colMatch[1],
        type: colMatch[2],
      });
    }

    tables.push({ name: tableName, columns });
  }

  return tables;
}

function buildOpenApi(routes) {
  const paths = {};

  for (const route of routes) {
    if (!paths[route.path]) paths[route.path] = {};
    const methodKey = route.method.toLowerCase();
    paths[route.path][methodKey] = {
      operationId: route.handler,
      responses: {
        '200': { description: 'Success' },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Open DroneLog Generated API Surface',
      version: 'generated',
      description: 'Generated from src-tauri/src/server.rs router declarations.',
    },
    paths,
  };
}

function buildGraph() {
  return {
    nodes: [
      { id: 'domain.project', type: 'domain', file: 'context/domains/project.json' },
      { id: 'domain.architecture', type: 'domain', file: 'context/domains/architecture.json' },
      { id: 'domain.runtime', type: 'domain', file: 'context/domains/runtime.json' },
      { id: 'generated.api-routes', type: 'generated', file: 'context/generated/api-routes.json' },
      { id: 'generated.openapi', type: 'generated', file: 'context/generated/openapi.json' },
      { id: 'generated.db-schema', type: 'generated', file: 'context/generated/db-schema.json' },
      { id: 'generated.deps-frontend', type: 'generated', file: 'context/generated/deps-frontend.json' },
      { id: 'generated.deps-rust', type: 'generated', file: 'context/generated/deps-rust.json' },
      { id: 'generated.env-vars', type: 'generated', file: 'context/generated/env-vars.json' },
      { id: 'generated.tauri-commands', type: 'generated', file: 'context/generated/tauri-commands.json' },
    ],
    edges: [
      { from: 'domain.architecture', to: 'generated.api-routes', relation: 'verified_by' },
      { from: 'domain.architecture', to: 'generated.openapi', relation: 'verified_by' },
      { from: 'domain.project', to: 'generated.deps-frontend', relation: 'verified_by' },
      { from: 'domain.project', to: 'generated.deps-rust', relation: 'verified_by' },
      { from: 'domain.runtime', to: 'generated.env-vars', relation: 'verified_by' },
      { from: 'domain.architecture', to: 'generated.db-schema', relation: 'verified_by' },
      { from: 'domain.architecture', to: 'generated.tauri-commands', relation: 'verified_by' },
    ],
  };
}

function collectManifestArtifacts() {
  const entries = [];
  const domainDir = path.join(contextDir, 'domains');

  if (fs.existsSync(domainDir)) {
    for (const file of fs.readdirSync(domainDir).filter((f) => f.endsWith('.json')).sort()) {
      entries.push({
        id: `domain.${file.replace(/\.json$/, '')}`,
        type: 'domain',
        file: `context/domains/${file}`,
      });
    }
  }

  if (fs.existsSync(generatedDir)) {
    for (const file of fs.readdirSync(generatedDir).filter((f) => f.endsWith('.json')).sort()) {
      entries.push({
        id: `generated.${file.replace(/\.json$/, '')}`,
        type: 'generated',
        file: `context/generated/${file}`,
      });
    }
  }

  return entries;
}

function run() {
  const packageJson = readJson('package.json');
  const cargoToml = readText('src-tauri/Cargo.toml');
  const serverRs = readText('src-tauri/src/server.rs');
  const chatWebRs = readText('src-tauri/src/chat/web.rs');
  const mcpHttpRs = readText('src-tauri/src/mcp/http.rs');
  const apiTs = readText('src/lib/api.ts');
  const databaseRs = readText('src-tauri/src/database.rs');
  const readme = readText('README.md');
  const compose = readText('docker-compose.yml');
  const composeBuild = readText('docker-compose-build.yml');

  const readmeEnvVars = uniqueSorted(parseEnvVarsFromReadme(readme));
  const composeEnvVars = uniqueSorted(parseEnvVarsFromCompose(compose));
  const composeBuildEnvVars = uniqueSorted(parseEnvVarsFromCompose(composeBuild));

  const fingerprints = {
    packageJson: hashText(JSON.stringify(packageJson)),
    cargoToml: hashText(cargoToml),
    serverRs: hashText(`${serverRs}\n${chatWebRs}\n${mcpHttpRs}`),
    apiTs: hashText(apiTs),
    databaseRs: hashText(databaseRs),
    readmeEnvVars: hashText(JSON.stringify(readmeEnvVars)),
    composeEnvVars: hashText(JSON.stringify(composeEnvVars)),
    composeBuildEnvVars: hashText(JSON.stringify(composeBuildEnvVars)),
  };

  const frontendDeps = {
    sourceFingerprint: fingerprints.packageJson,
    packageName: packageJson.name,
    projectVersion: packageJson.version,
    dependencies: Object.keys(packageJson.dependencies || {}).sort(),
    devDependencies: Object.keys(packageJson.devDependencies || {}).sort(),
  };

  const rustDeps = {
    sourceFingerprint: fingerprints.cargoToml,
    crate: 'open-dronelog',
    dependencies: parseCargoDependencies(cargoToml),
  };

  const routes = [...parseRoutes(serverRs), ...parseRoutes(chatWebRs), ...parseRoutes(mcpHttpRs)];
  const apiRoutes = {
    sourceFingerprint: fingerprints.serverRs,
    sourceFile: 'src-tauri/src/server.rs',
    routes,
  };

  const tauriCommands = {
    sourceFingerprint: fingerprints.apiTs,
    sourceFile: 'src/lib/api.ts',
    commands: parseTauriCommands(apiTs),
  };

  const envVars = uniqueSorted([
    ...composeEnvVars,
    ...composeBuildEnvVars,
    ...readmeEnvVars,
  ]);

  const envVarsDoc = {
    sourceFingerprints: {
      readmeEnvVars: fingerprints.readmeEnvVars,
      composeEnvVars: fingerprints.composeEnvVars,
      composeBuildEnvVars: fingerprints.composeBuildEnvVars,
    },
    sources: ['README.md', 'docker-compose.yml', 'docker-compose-build.yml'],
    variables: envVars,
  };

  const dbSchema = {
    sourceFingerprint: fingerprints.databaseRs,
    sourceFile: 'src-tauri/src/database.rs',
    tables: parseTables(databaseRs),
  };

  const openApi = buildOpenApi(routes);
  openApi.info['x-source-fingerprint'] = fingerprints.serverRs;

  writeJson(path.join(generatedDir, 'deps-frontend.json'), frontendDeps);
  writeJson(path.join(generatedDir, 'deps-rust.json'), rustDeps);
  writeJson(path.join(generatedDir, 'api-routes.json'), apiRoutes);
  writeJson(path.join(generatedDir, 'tauri-commands.json'), tauriCommands);
  writeJson(path.join(generatedDir, 'env-vars.json'), envVarsDoc);
  writeJson(path.join(generatedDir, 'db-schema.json'), dbSchema);
  writeJson(path.join(generatedDir, 'openapi.json'), openApi);

  writeJson(path.join(linksDir, 'graph.json'), buildGraph());

  const manifest = {
    schemaVersion: 1,
    sourceFingerprints: fingerprints,
    artifacts: collectManifestArtifacts(),
    pointers: {
      linksGraph: 'context/links/graph.json',
      schemaDir: 'context/schema',
      domainsDir: 'context/domains',
      generatedDir: 'context/generated',
    },
  };

  writeJson(path.join(contextDir, 'manifest.json'), manifest);

  console.log('Context extraction complete.');
  console.log(`- Routes: ${routes.length}`);
  console.log(`- Env vars: ${envVars.length}`);
  console.log(`- Tables: ${dbSchema.tables.length}`);
}

run();
