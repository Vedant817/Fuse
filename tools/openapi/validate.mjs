#!/usr/bin/env node
import process from 'node:process';
import { loadOpenApiDocument, validateOpenApiDocument } from './validator.mjs';

try {
  const result = validateOpenApiDocument(loadOpenApiDocument());
  process.stdout.write(
    `OpenAPI validation passed: ${result.operationCount} operations, ${result.referenceCount} local references\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
