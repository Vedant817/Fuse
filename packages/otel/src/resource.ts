import {
  defaultResource,
  resourceFromAttributes,
  type Resource,
} from '@opentelemetry/resources';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { FUSE_TELEMETRY_SCHEMA_VERSION } from './attributes.js';

export interface FuseResourceOptions {
  serviceName: string;
  serviceVersion: string;
  deploymentEnvironment: string;
}

export function buildFuseResource(options: FuseResourceOptions): Resource {
  return defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.deploymentEnvironment,
      'fuse.telemetry_schema_version': FUSE_TELEMETRY_SCHEMA_VERSION,
    }),
  );
}
