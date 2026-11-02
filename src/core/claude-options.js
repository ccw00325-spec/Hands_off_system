// Keep the original CLI's OAuth/keychain authentication enabled. --bare disables it.
export function officialClaudeArgs() {
  return ['--tools','','--setting-sources','','--settings','{"disableAllHooks":true,"enabledPlugins":{}}',
    '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--no-session-persistence'];
}
