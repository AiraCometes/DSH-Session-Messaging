import Schema from '@deepseek-ai/schemastery';

const positive = fallback => Schema.number().step(1).min(1).default(fallback);
const envName = fallback => Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default(fallback);
const session = Schema.object({
  id: Schema.string().min(1).required().description('Stable identity used by the messaging tools.'),
  role: Schema.union(['tower', 'spec', 'implementation', 'review']).required(),
  address: Schema.string().min(1).required().description('Exact Session ID of the live Harness agent.'),
  provider: Schema.string().min(1).required().description('Configured provider label for the audit log.'),
  model: Schema.string().min(1).required().description('Configured model label; this does not select a model.'),
});
const github = Schema.object({
  target: Schema.string().min(1).required().description('Configured session identity that receives events.'),
  sender: Schema.string().min(1).default('github'),
  secretEnv: envName('DSH_TOWER_GITHUB_SECRET'),
  repositories: Schema.array(Schema.string().pattern(/^[\w.-]+\/[\w.-]+$/)).min(1).required(),
});

/** Standard Schema consumed by Cordis and DSH's configuration editor. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('Enable after configuring explicit session bindings.'),
  database: Schema.string().min(1).default('.tower/control-tower.sqlite').description('Prefer an absolute path for profile-based launches.'),
  sessions: Schema.array(session).default([]),
  viewer: Schema.boolean().default(true),
  viewerTokenEnv: envName('DSH_TOWER_VIEWER_TOKEN'),
  port: Schema.number().step(1).min(0).max(65535).default(3091).description('Viewer port; 0 chooses an available port.'),
  pollMs: Schema.number().step(1).min(100).max(60000).default(500),
  limits: Schema.object({
    maxMessageBytes: positive(65536), maxPending: positive(1000),
    maxThreadMessages: positive(32), maxSendsPerMinute: positive(60),
  }),
  github: Schema.union([github, Schema.const(null)]).default(null),
});
