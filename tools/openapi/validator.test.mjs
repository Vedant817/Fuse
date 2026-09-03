import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertResponseConforms,
  loadOpenApiDocument,
  validateOpenApiDocument,
} from './validator.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('accepts the checked-in OpenAPI contract', () => {
  const result = validateOpenApiDocument(loadOpenApiDocument());
  assert.equal(result.operationCount, 18);
  assert.ok(result.referenceCount > 0);
});

test('rejects an unresolved local reference', () => {
  const document = clone(loadOpenApiDocument());
  document.paths['/v1/permit'].post.responses['200'].content[
    'application/json'
  ].schema.$ref = '#/components/schemas/DoesNotExist';
  assert.throws(() => validateOpenApiDocument(document), /unresolvable local \$ref/);
});

test('rejects duplicate operation IDs and missing reusable global errors', () => {
  const duplicate = clone(loadOpenApiDocument());
  duplicate.paths['/readyz'].get.operationId = 'getHealthz';
  assert.throws(() => validateOpenApiDocument(duplicate), /duplicate operationId/);

  const missingError = clone(loadOpenApiDocument());
  delete missingError.paths['/v1/permit'].post.responses['500'];
  assert.throws(() => validateOpenApiDocument(missingError), /must document 500/);

  const missingStoreUnavailable = clone(loadOpenApiDocument());
  delete missingStoreUnavailable.paths['/v1/slack/interactive'].post.responses['503'];
  assert.throws(
    () => validateOpenApiDocument(missingStoreUnavailable),
    /POST \/v1\/slack\/interactive must document 503/,
  );
});

test('rejects an anonymous security override on a bearer-authenticated route', () => {
  const document = clone(loadOpenApiDocument());
  document.paths['/v1/permit'].post.security = [];
  assert.throws(() => validateOpenApiDocument(document), /must require bearerAuth/);
});

test('rejects a documented response body with a missing required field', () => {
  const document = loadOpenApiDocument();
  assert.throws(
    () =>
      assertResponseConforms(document, {
        method: 'post',
        path: '/v1/permit',
        statusCode: 200,
        body: {
          allowed: true,
          state: 'armed',
          reason: 'armed',
          epoch: 0,
          degraded: false,
        },
      }),
    /correlationId is required/,
  );
});
