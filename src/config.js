import Schema from '@deepseek-ai/schemastery';
import {
  TowerError, integer, text, IDENTIFIER_PATTERN, IDENTIFIER_MAX_BYTES,
  SESSION_ADDRESS_MAX_BYTES, SESSION_LABEL_MAX_BYTES, GITHUB_REPOSITORY_PATTERN,
} from './core/validation.js';

// Preserve quoted decimal integers from YAML, but reject paths, floats and exponents.
const numeric = (label, min, max) => Schema.transform(
  Schema.union([Schema.number(), Schema.string().pattern(/^\d+$/)]),
  value => {
    try { return integer(typeof value === 'string' ? Number(value) : value, label, min, max); }
    catch {
      // A failed numeric union discards its branch's range error. Validate both
      // input types together and retain this field's path for Cordis as well.
      throw new Schema.ValidationError(`expected an integer from ${min} to ${max}`, { path: label.split('.') });
    }
  },
);
const positive = (label, fallback) => numeric(`limits.${label}`, 1, Number.MAX_SAFE_INTEGER).default(fallback);
const envName = fallback => Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default(fallback);
const id = () => Schema.string().min(1).max(IDENTIFIER_MAX_BYTES).pattern(IDENTIFIER_PATTERN);
const boundedText = (label, max) => Schema.transform(
  Schema.string().min(1).max(max), value => text(value, label, max));
const session = Schema.object({
  id: id().required().description('Stable identity used by the messaging tools.'),
  role: Schema.union(['tower', 'spec', 'implementation', 'review']).required(),
  address: boundedText('address', SESSION_ADDRESS_MAX_BYTES).required().description('Exact Session ID; at most 500 UTF-8 bytes.'),
  provider: boundedText('provider', SESSION_LABEL_MAX_BYTES).required().description('Configured provider label for the audit log.'),
  model: boundedText('model', SESSION_LABEL_MAX_BYTES).required().description('Configured model label; this does not select a model.'),
});
const github = Schema.object({
  target: id().required().description('Configured session identity that receives events.'),
  sender: id().default('github'),
  secretEnv: envName('DSH_TOWER_GITHUB_SECRET'),
  repositories: Schema.array(Schema.string().pattern(GITHUB_REPOSITORY_PATTERN)).min(1).required(),
});

const enabledConfig = Schema.object({
  enabled: Schema.const(true).required(),
  database: Schema.string().min(1).default('.tower/control-tower.sqlite').description('Prefer an absolute path for profile-based launches.'),
  sessions: Schema.array(session).default([]),
  viewer: Schema.boolean().default(true),
  viewerTokenEnv: envName('DSH_TOWER_VIEWER_TOKEN'),
  port: numeric('port', 0, 65535).default(3091).description('Viewer port; 0 chooses an available port.'),
  pollMs: numeric('pollMs', 100, 60000).default(500),
  limits: Schema.object({
    maxMessageBytes: positive('maxMessageBytes', 65536), maxPending: positive('maxPending', 1000),
    maxThreadMessages: positive('maxThreadMessages', 32), maxSendsPerMinute: positive('maxSendsPerMinute', 60),
  }),
  github: Schema.union([github, Schema.const(null)]).default(null),
});

/** Cordis validates before apply(), so the exported schema must also allow dormant drafts. */
export const Config = Schema.union([
  // Check the inert branch before any operational transforms can run.
  // Unknown fields are retained for editing/migration, never activated.
  Schema.object({ enabled: Schema.const(false).default(false) }),
  enabledConfig,
]).required();

// Cordis validates through Standard Schema before apply(). Select the active
// branch there too, so its issues retain field paths rather than a union dump.
// The native union graph remains available to DSH's static schema projector.
const standard = Config['~standard'];
Object.defineProperty(Config, '~standard', {
  value: {
    ...standard,
    validate(input) {
      try {
        return input?.enabled === true
          ? enabledConfig['~standard'].validate(input)
          : standard.validate(input);
      } catch (cause) {
        // Shared byte/nonblank checks throw TowerError, not Schemastery's error.
        if (cause instanceof TowerError) return { issues: [{ message: cause.message }] };
        throw cause;
      }
    },
  },
});

/** Both runtime entry points share defaults and structured configuration errors. */
export function resolveConfig(input) {
  try { return input?.enabled === true ? enabledConfig(input) : Config(input); }
  catch (cause) {
    throw new TowerError('INVALID_CONFIG', `Invalid Session Messaging configuration: ${cause.message}`);
  }
}
