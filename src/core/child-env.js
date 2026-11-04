// CLI credentials stay in the current OS user's native CLI store, not inherited API keys.
export function projectEnvironment(extra = {}) {
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TZ)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), ...extra };
}
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
    "NODE_TEST_CONTEXT",
    "NODE_TEST_REPORTER",
    "NODE_TEST_REPORTER_DESTINATION",
  ])
    delete env[name];
  return { ...env, ...extra };
}
