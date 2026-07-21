/**
 * Namespaced extensions to the standard `gen_ai.*` attributes (AGENTS.md:
 * "standard gen_ai names where available and namespaced extensions where
 * necessary"). Everything Fuse needs that isn't part of the gen_ai
 * semantic conventions lives under the `fuse.` prefix.
 */
export const ATTR_FUSE_TENANT = 'fuse.tenant';
export const ATTR_FUSE_ENVIRONMENT = 'fuse.environment';
export const ATTR_FUSE_AGENT_ID = 'fuse.agent_id';
export const ATTR_FUSE_SESSION_ID = 'fuse.session_id';
export const ATTR_FUSE_TASK_ID = 'fuse.task_id';
export const ATTR_FUSE_STEP_INDEX = 'fuse.step_index';
export const ATTR_FUSE_SCENARIO = 'fuse.scenario';
export const ATTR_FUSE_OUTCOME = 'fuse.outcome';
export const ATTR_FUSE_ESTIMATED_COST_USD = 'fuse.estimated_cost.usd';
export const ATTR_FUSE_POLICY_VERSION = 'fuse.policy_version';
export const ATTR_FUSE_CORRELATION_ID = 'fuse.correlation_id';

/** Bumped whenever the shape of Fuse's emitted attributes changes in a way
 * that could break a detector or dashboard — lets Preflight (task.md §6)
 * distinguish "no telemetry" from "telemetry from a build that changed
 * shape." */
export const FUSE_TELEMETRY_SCHEMA_VERSION = 'fuse-telemetry-v1';
