// CLI credentials stay in the current OS user's native CLI store, not inherited API keys.
export function nativeEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /(?:API_KEY|ACCESS_KEY|(?:^|_)TOKEN$|AUTHORIZATION|SECRET|PASSWORD|PRIVATE_KEY)/i.test(
        key,
      )
    )
      delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "ELECTRON_EXTRA_LAUNCH_ARGS",
    "BASH_ENV",
    "ENV",
  ])
    delete env[name];
  return { ...env, ...extra };
}
