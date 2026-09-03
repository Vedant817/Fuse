import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function validateSbom(sbom, format, expectedComponents) {
  let components;
  if (format === 'cyclonedx') {
    if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6') {
      throw new Error('Expected a CycloneDX 1.6 SBOM.');
    }
    components = sbom.components;
  } else if (format === 'spdx') {
    if (sbom.spdxVersion !== 'SPDX-2.3') {
      throw new Error('Expected an SPDX 2.3 SBOM.');
    }
    components = sbom.packages;
  } else {
    throw new Error(`Unsupported SBOM format: ${format}`);
  }
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('SBOM contains no components.');
  }

  const names = new Set();
  for (const component of components) {
    if (typeof component.name === 'string') names.add(component.name);
    if (component.group && typeof component.name === 'string') {
      names.add(`${component.group}/${component.name}`);
    }
  }
  const missing = expectedComponents.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `SBOM is missing expected runtime components: ${missing.join(', ')}; found: ${[...names].sort().join(', ')}`,
    );
  }
  return components.length;
}

async function main() {
  const [format, file, ...expectedComponents] = process.argv.slice(2);
  if (!format || !file || expectedComponents.length === 0) {
    throw new Error(
      'Usage: validate-sbom.mjs <cyclonedx|spdx> <file> <expected-component...>',
    );
  }
  const sbom = JSON.parse(await readFile(resolve(file), 'utf8'));
  const count = validateSbom(sbom, format, expectedComponents);
  process.stdout.write(
    `${format} SBOM accepted: ${count} components; required runtime components present.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
