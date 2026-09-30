import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['validate','synth','deploy'].includes(mode)) throw new Error('Expected validate, synth or deploy');
const fixture = mode === 'synth';
const configFile = fixture ? path.join(root, 'config.fixture.json') : path.resolve(process.env.COURTLENS_CONFIG_FILE || path.join(root, 'deploy.json'));
if (!fs.existsSync(configFile)) throw new Error(`Configuration missing: ${configFile}. Copy config.example.json and fill Portal-confirmed values.`);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (mode !== 'synth') {
  const required = ['teamAccountId','allowedRegion','portalConfirmedAgentService','portalConfirmedModelId','portalEvidence','modelResourceArn','operatorEmail','siteAssetDirectory'];
  const missing = required.filter(k => !config[k] || String(config[k]).startsWith('REPLACE_'));
  if (missing.length || !config.contestConfigConfirmed || config.fixtureOnly || config.teamAccountId === '111111111111' || config.portalConfirmedAgentService !== 'bedrock-agentcore') throw new Error(`Formal config blocked: ${missing.join(', ') || 'Portal confirmation, account, or Agent service invalid'}`);
}
if (mode === 'deploy') {
  const check = spawnSync('aws', ['sts','get-caller-identity','--query','Account','--output','text'], {encoding:'utf8', env:process.env});
  if (check.status !== 0) throw new Error(`AWS caller identity failed: ${check.stderr.trim()}`);
  if (check.stdout.trim() !== config.teamAccountId) throw new Error(`AWS caller account ${check.stdout.trim()} does not match confirmed teamAccountId`);
  if (process.env.AWS_REGION && process.env.AWS_REGION !== config.allowedRegion) throw new Error('AWS_REGION conflicts with confirmed allowedRegion');
  if (process.env.AWS_DEFAULT_REGION && process.env.AWS_DEFAULT_REGION !== config.allowedRegion) throw new Error('AWS_DEFAULT_REGION conflicts with confirmed allowedRegion');
}
const env = {...process.env, COURTLENS_CONFIG_FILE:configFile, COURTLENS_SYNTH_FIXTURE:fixture?'1':'0', AWS_REGION:config.allowedRegion, AWS_DEFAULT_REGION:config.allowedRegion};
const cdk = path.join(root,'node_modules','aws-cdk','bin','cdk');
if (mode === 'deploy') {
  const bootstrap = spawnSync(process.execPath, [cdk,'bootstrap',`aws://${config.teamAccountId}/${config.allowedRegion}`], {cwd:root,env,stdio:'inherit'});
  if (bootstrap.status !== 0) process.exit(bootstrap.status || 1);
}
const args = mode === 'validate' ? ['synth','--quiet'] : mode === 'synth' ? ['synth'] : ['deploy', '--all', '--require-approval', 'never'];
const result = spawnSync(process.execPath, [cdk,...args], {cwd:root,env,stdio:'inherit'});
if (result.status !== 0) process.exit(result.status || 1);
