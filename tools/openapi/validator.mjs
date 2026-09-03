import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const OPENAPI_PATH = fileURLToPath(
  new URL('../../docs/openapi.yaml', import.meta.url),
);

const HTTP_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]);

const EXPECTED_OPERATIONS = new Map([
  ['GET /healthz', 'getHealthz'],
  ['GET /readyz', 'getReadyz'],
  ['POST /v1/scopes/register', 'postScopeRegister'],
  ['GET /v1/policies/effective', 'getEffectivePolicy'],
  ['POST /v1/permit', 'postPermit'],
  ['POST /v1/breaker/trip', 'postBreakerTrip'],
  ['POST /v1/breaker/resume', 'postBreakerResume'],
  ['POST /v1/breaker/disable', 'postBreakerDisable'],
  ['POST /v1/breaker/enable', 'postBreakerEnable'],
  ['GET /v1/breaker/status', 'getBreakerStatus'],
  ['POST /v1/preflight/report', 'postPreflightReport'],
  ['POST /v1/preflight/exporter-evidence', 'postPreflightExporterEvidence'],
  ['GET /v1/preflight/status', 'getPreflightStatus'],
  ['POST /v1/detectors/observe', 'postDetectorsObserve'],
  ['GET /v1/diagnosis/jobs', 'listDiagnosisJobs'],
  ['POST /v1/diagnosis/jobs/{auditEventId}/replay', 'replayDiagnosisJob'],
  ['POST /v1/webhooks/signoz', 'postWebhooksSignoz'],
  ['POST /v1/slack/interactive', 'postSlackInteractive'],
]);

const PUBLIC_OPERATIONS = new Set(['getHealthz', 'getReadyz']);
const SLACK_OPERATION = 'postSlackInteractive';
const RATE_LIMIT_EXEMPT_OPERATIONS = new Set(['getHealthz', 'getReadyz']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationEntries(document) {
  assert.ok(isObject(document.paths), 'OpenAPI document must define paths');
  const operations = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    assert.ok(isObject(pathItem), `path item ${path} must be an object`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      assert.ok(isObject(operation), `${method.toUpperCase()} ${path} must be an object`);
      operations.push({ method: method.toUpperCase(), path, operation });
    }
  }
  return operations;
}

export function loadOpenApiDocument(path = OPENAPI_PATH) {
  const parsed = parseDocument(readFileSync(path, 'utf8'), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0) {
    throw new Error(
      `OpenAPI YAML is invalid:\n${parsed.errors.map((error) => error.message).join('\n')}`,
    );
  }
  const document = parsed.toJS();
  assert.ok(isObject(document), 'OpenAPI YAML root must be an object');
  return document;
}

export function resolveLocalRef(document, ref) {
  assert.equal(typeof ref, 'string', '$ref must be a string');
  assert.ok(ref.startsWith('#/'), `only local OpenAPI references are allowed: ${ref}`);
  let value = document;
  for (const encodedSegment of ref.slice(2).split('/')) {
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    assert.ok(isObject(value) || Array.isArray(value), `unresolvable local $ref: ${ref}`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(value, segment),
      `unresolvable local $ref: ${ref}`,
    );
    value = value[segment];
  }
  return value;
}

function resolveSchema(document, schema) {
  assert.ok(isObject(schema), 'schema must be an object');
  return typeof schema.$ref === 'string'
    ? resolveSchema(document, resolveLocalRef(document, schema.$ref))
    : schema;
}

function walk(value, visit, seen = new Set()) {
  if (!isObject(value) && !Array.isArray(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const child of Object.values(value)) walk(child, visit, seen);
}

function assertRequired(schema, names, label) {
  assert.ok(Array.isArray(schema.required), `${label} must define required fields`);
  for (const name of names) {
    assert.ok(schema.required.includes(name), `${label} must require ${name}`);
  }
}

function operationAt(document, method, path) {
  const pathItem = document.paths?.[path];
  const operation = pathItem?.[method.toLowerCase()];
  assert.ok(isObject(operation), `missing operation ${method.toUpperCase()} ${path}`);
  return operation;
}

function requestSchemaAt(document, method, path) {
  const operation = operationAt(document, method, path);
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  assert.ok(isObject(schema), `${method.toUpperCase()} ${path} must define a JSON body`);
  return resolveSchema(document, schema);
}

function assertResponseRef(operation, status, expectedRef, label) {
  const response = operation.responses?.[status];
  assert.ok(isObject(response), `${label} must document ${status}`);
  assert.equal(
    response.$ref,
    expectedRef,
    `${label} ${status} must reuse ${expectedRef}`,
  );
}

function assertTargetedRouteSchemas(document) {
  const exporter = requestSchemaAt(document, 'post', '/v1/preflight/exporter-evidence');
  assert.equal(exporter.additionalProperties, false);
  assertRequired(exporter, ['scope', 'spans', 'exporterDelivery'], 'exporter evidence');
  const exporterDelivery = resolveSchema(document, exporter.properties.exporterDelivery);
  assert.equal(exporterDelivery.additionalProperties, false);
  assertRequired(
    exporterDelivery,
    ['status', 'observedAtMs', 'sourceInstanceId', 'sequence'],
    'exporter delivery',
  );
  assert.deepEqual(exporterDelivery.properties.status.enum, ['success', 'failure']);
  assert.equal(exporterDelivery.properties.sequence.minimum, 1);

  const replayPath = '/v1/diagnosis/jobs/{auditEventId}/replay';
  const replayOperation = operationAt(document, 'post', replayPath);
  const auditParameter = replayOperation.parameters?.find(
    (parameter) => parameter.name === 'auditEventId' && parameter.in === 'path',
  );
  assert.ok(auditParameter?.required, 'diagnosis replay must require auditEventId');
  assert.equal(auditParameter.schema?.format, 'uuid');
  const replay = requestSchemaAt(document, 'post', replayPath);
  assert.equal(replay.additionalProperties, false);
  assertRequired(
    replay,
    ['scope', 'actor', 'reason', 'idempotencyKey'],
    'diagnosis replay',
  );
  const actor = replay.properties.actor;
  assert.ok(Array.isArray(actor.allOf), 'diagnosis replay actor must narrow Actor');
  assert.ok(
    actor.allOf.some((part) => part.properties?.type?.enum?.includes('manual')),
    'diagnosis replay actor must be manual',
  );
  const replayResponse =
    replayOperation.responses?.['200']?.content?.['application/json']?.schema;
  assert.ok(isObject(replayResponse), 'diagnosis replay must define its 200 JSON schema');
  assertRequired(replayResponse, ['job', 'replayed'], 'diagnosis replay response');
  const job = resolveSchema(document, replayResponse.properties.job);
  assertRequired(
    job,
    [
      'auditEventId',
      'scope',
      'detector',
      'measurement',
      'reason',
      'correlationId',
      'startsAt',
      'tripEpoch',
      'notifySlack',
      'status',
      'attempts',
      'availableAt',
      'leasedBy',
      'leasedUntil',
      'lastError',
      'createdAt',
      'updatedAt',
      'completedAt',
    ],
    'diagnosis job',
  );

  const step = resolveSchema(document, document.components.schemas.StepObservation);
  assert.ok(
    Array.isArray(step.oneOf),
    'StepObservation must document available and unavailable pricing forms',
  );
  const stepRefs = new Set(step.oneOf.map((part) => part.$ref));
  for (const ref of [
    '#/components/schemas/AvailablePricedStepObservation',
    '#/components/schemas/UnavailablePricedStepObservation',
  ]) {
    assert.ok(stepRefs.has(ref), `StepObservation must include ${ref}`);
  }
  assert.equal(stepRefs.size, 2, 'StepObservation must not retain legacy input forms');
}

export function validateOpenApiDocument(document) {
  assert.equal(document.openapi, '3.0.3');
  assert.ok(isObject(document.components?.securitySchemes?.bearerAuth));
  assert.ok(isObject(document.components?.securitySchemes?.slackSignature));

  let referenceCount = 0;
  walk(document, (value) => {
    if (isObject(value) && Object.prototype.hasOwnProperty.call(value, '$ref')) {
      resolveLocalRef(document, value.$ref);
      referenceCount += 1;
    }
  });

  const operations = operationEntries(document);
  assert.equal(operations.length, 18, 'OpenAPI must define exactly 18 operations');
  assert.equal(EXPECTED_OPERATIONS.size, 18);
  const operationIds = new Set();
  const actualOperationKeys = new Set();
  for (const { method, path, operation } of operations) {
    const label = `${method} ${path}`;
    actualOperationKeys.add(label);
    const expectedId = EXPECTED_OPERATIONS.get(label);
    assert.ok(expectedId, `unexpected OpenAPI operation ${label}`);
    assert.equal(typeof operation.operationId, 'string', `${label} needs operationId`);
    assert.ok(
      !operationIds.has(operation.operationId),
      `duplicate operationId: ${operation.operationId}`,
    );
    operationIds.add(operation.operationId);
    assert.equal(operation.operationId, expectedId, `${label} operationId drifted`);

    const security = operation.security ?? document.security;
    if (PUBLIC_OPERATIONS.has(operation.operationId)) {
      assert.deepEqual(
        operation.security,
        [],
        `${label} must explicitly opt out of bearer auth`,
      );
    } else if (operation.operationId === SLACK_OPERATION) {
      assert.deepEqual(
        operation.security,
        [{ slackSignature: [] }],
        `${label} must require Slack signature authentication`,
      );
    } else {
      assert.ok(
        Array.isArray(security) &&
          security.length > 0 &&
          security.every(
            (requirement) =>
              isObject(requirement) &&
              Object.keys(requirement).length === 1 &&
              Array.isArray(requirement.bearerAuth) &&
              requirement.bearerAuth.length === 0,
          ),
        `${label} must require bearerAuth`,
      );
      assertResponseRef(operation, '400', '#/components/responses/BadRequest', label);
      assertResponseRef(
        operation,
        '401',
        '#/components/responses/Unauthenticated',
        label,
      );
      assertResponseRef(operation, '403', '#/components/responses/Unauthorized', label);
    }

    if (!RATE_LIMIT_EXEMPT_OPERATIONS.has(operation.operationId)) {
      assertResponseRef(
        operation,
        '429',
        '#/components/responses/TooManyRequests',
        label,
      );
      assertResponseRef(
        operation,
        '503',
        '#/components/responses/StoreUnavailable',
        label,
      );
    } else {
      assert.equal(
        operation.responses?.['429'],
        undefined,
        `${label} bypasses rate limiting`,
      );
    }
    assertResponseRef(operation, '500', '#/components/responses/InternalError', label);
  }
  assert.deepEqual(actualOperationKeys, new Set(EXPECTED_OPERATIONS.keys()));

  const slack = operationAt(document, 'post', '/v1/slack/interactive');
  for (const status of ['400', '401', '403']) {
    const schema = slack.responses?.[status]?.content?.['application/json']?.schema;
    assert.equal(
      schema?.$ref,
      '#/components/schemas/SlackCallbackError',
      `Slack ${status} must use its signature-auth error schema`,
    );
  }

  assertTargetedRouteSchemas(document);
  return { operationCount: operations.length, referenceCount };
}

function schemaErrors(document, schemaInput, value, location) {
  const schema = resolveSchema(document, schemaInput);
  if (value === null && schema.nullable === true) return [];

  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((part) => schemaErrors(document, part, value, location));
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (part) => schemaErrors(document, part, value, location).length === 0,
    );
    return matches.length === 1
      ? []
      : [`${location} must match exactly one oneOf schema (matched ${matches.length})`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return [`${location} must be one of ${JSON.stringify(schema.enum)}`];
  }

  const errors = [];
  if (schema.type === 'object') {
    if (!isObject(value)) return [`${location} must be an object`];
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(`${location}.${required} is required`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        errors.push(
          ...schemaErrors(document, propertySchema, child, `${location}.${key}`),
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key} is not allowed`);
      } else if (isObject(schema.additionalProperties)) {
        errors.push(
          ...schemaErrors(
            document,
            schema.additionalProperties,
            child,
            `${location}.${key}`,
          ),
        );
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${location} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${location} must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(
          ...schemaErrors(document, schema.items, item, `${location}[${index}]`),
        );
      });
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${location} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${location} must have length >= ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${location} must have length <= ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${location} must match ${schema.pattern}`);
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${location} must be a date-time`);
    }
    if (
      schema.format === 'uuid' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      errors.push(`${location} must be a UUID`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return [`${location} must be an integer`];
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return [`${location} must be a finite number`];
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return [`${location} must be a boolean`];
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${location} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${location} must be <= ${schema.maximum}`);
    }
  }
  return errors;
}

export function assertResponseConforms(document, { method, path, statusCode, body }) {
  const operation = operationAt(document, method, path);
  const response = operation.responses?.[String(statusCode)];
  assert.ok(
    isObject(response),
    `${method.toUpperCase()} ${path} does not document response ${statusCode}`,
  );
  const resolvedResponse =
    typeof response.$ref === 'string'
      ? resolveLocalRef(document, response.$ref)
      : response;
  const schema = resolvedResponse.content?.['application/json']?.schema;
  if (!schema) {
    assert.equal(
      body,
      undefined,
      `${method.toUpperCase()} ${path} ${statusCode} has no body`,
    );
    return;
  }
  const errors = schemaErrors(document, schema, body, 'response');
  assert.deepEqual(
    errors,
    [],
    `${method.toUpperCase()} ${path} ${statusCode} response does not conform:\n${errors.join('\n')}`,
  );
}
