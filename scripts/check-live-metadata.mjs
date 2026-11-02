import { ClaudeConnection } from '../src/core/claude.js';
import { CodexUsage,readClaudeUsage } from '../src/core/usage.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory=resolve('artifacts');await mkdir(directory,{recursive:true});
const claude=new ClaudeConnection();const codex=new CodexUsage();
try{
  const [status,claudeUsage,codexUsage]=await Promise.all([claude.status(),readClaudeUsage(claude,{cwd:directory}),codex.read()]);
  const result={claude:{installed:status.installed,connected:status.connected,state:claudeUsage.state,remainingPercent:claudeUsage.remainingPercent,meters:claudeUsage.meters?.length??0},
    codex:{state:codexUsage.state,remainingPercent:codexUsage.remainingPercent,meters:codexUsage.meters?.length??0},operation:'official read-only account/usage metadata; no task or model prompt',checkedAt:new Date().toISOString()};
  await writeFile(resolve(directory,'live-metadata-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{codex.close();}
