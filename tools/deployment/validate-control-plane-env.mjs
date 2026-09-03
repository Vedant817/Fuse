/* global console, process */
import { resolve } from 'node:path';

const envFile = process.argv[2];
if (envFile) process.loadEnvFile(resolve(envFile));

const { loadConfig } = await import('../../services/control-plane/dist/config.js');
const config = loadConfig(process.env);
if (config.deploymentEnvironment !== 'production') {
  throw new Error('CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT must be production');
}

console.log('production control-plane configuration is valid');
