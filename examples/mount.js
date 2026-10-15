/** Call from an existing Harness host after agents/tools services are available. */
import * as sessionMessaging from '../src/plugin.js';
import config from './harness.config.json' with { type:'json' };

export function mount(ctx) {
  // Cordis owns initialization/disposal. This is not a standalone Harness launcher.
  return ctx.plugin(sessionMessaging, config);
}

// Optional config.github (configure secret in the host environment):
// {
//   target: 'control', sender: 'github', secretEnv: 'DSH_TOWER_GITHUB_SECRET',
//   repositories: ['AiraCometes/DSH-Session-Messaging']
// }
