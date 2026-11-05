import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
if (git('branch', '--show-current') !== 'main') throw new Error('Platform publication requires the reviewed main branch.');
if (git('diff', '--name-only') || git('diff', '--cached', '--name-only')) throw new Error('Commit the reviewed tracked changes before syncing.');
const head = git('rev-parse', 'HEAD');
for (const [remote, repository] of [['origin','Hands_off_system_Window'], ['mac','Hands_off_system_Mac']]) {
  const url = git('remote', 'get-url', remote);
  if (url !== `https://github.com/ccw00325-spec/${repository}.git`) throw new Error(`Unexpected ${remote} target; refusing to publish.`);
  execFileSync('git', ['push', remote, 'HEAD:refs/heads/main'], {stdio:'inherit'});
  const actual = git('ls-remote', remote, 'refs/heads/main').split(/\s/)[0];
  if (actual !== head) throw new Error(`${repository} does not match the reviewed commit.`);
  console.log(`${repository}: ${head}`);
}
