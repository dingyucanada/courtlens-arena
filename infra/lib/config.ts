import fs from 'node:fs';
import path from 'node:path';

export interface DeploymentConfig {
  teamAccountId: string;
  allowedRegion: string;
  portalConfirmedAgentService: string;
  portalConfirmedModelId: string;
  portalEvidence: string;
  contestConfigConfirmed: boolean;
  modelResourceArn: string;
  operatorEmail: string;
  siteAssetDirectory: string;
  voiceProviders?: Array<{ provider: 'minimax' | 'stepfun'; modelId: string; voiceId: string; secretArn: string; minimaxRegion?: 'global' | 'china'; stepfunApiVariant?: 'openapi' | 'step-plan' }>;
  polly?: { region: string; engine: 'neural'; voiceId: 'Zhiyu' };
  fixtureOnly?: boolean;
}

export function readConfig(): DeploymentConfig {
  const file = process.env.COURTLENS_CONFIG_FILE;
  if (!file) throw new Error('COURTLENS_CONFIG_FILE is required; use npm run synth for an offline fixture.');
  const resolved = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(resolved, 'utf8')) as DeploymentConfig;
  validateConfig(config, process.env.COURTLENS_SYNTH_FIXTURE === '1');
  return config;
}

export function validateConfig(config: DeploymentConfig, fixture: boolean): void {
  const missing = ['teamAccountId','allowedRegion','portalConfirmedAgentService','portalConfirmedModelId','portalEvidence','modelResourceArn','operatorEmail','siteAssetDirectory'].filter(k => !String(config[k as keyof DeploymentConfig] ?? '').trim() || String(config[k as keyof DeploymentConfig]).startsWith('REPLACE_'));
  if (missing.length) throw new Error(`Missing confirmed deployment fields: ${missing.join(', ')}`);
  if (!/^\d{12}$/.test(config.teamAccountId)) throw new Error('teamAccountId must be a 12-digit AWS account ID');
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(config.allowedRegion)) throw new Error('allowedRegion must be an AWS region code');
  if (config.portalConfirmedAgentService !== 'bedrock-agentcore') throw new Error('This stack implements only the AgentCore candidate; re-evaluate when Portal names another service.');
  if (!config.modelResourceArn.startsWith(`arn:aws:bedrock:${config.allowedRegion}:`)) throw new Error('modelResourceArn must name a model/profile in the confirmed region');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.operatorEmail)) throw new Error('operatorEmail is required for Cognito login');
  const voices = config.voiceProviders ?? [];
  if (!Array.isArray(voices) || voices.length > 2) throw new Error('voiceProviders must contain at most MiniMax and StepFun');
  const selected = new Set<string>();
  for (const voice of voices) {
    if (!voice || !['minimax','stepfun'].includes(voice.provider) || selected.has(voice.provider)) throw new Error('voiceProviders has an invalid or duplicate provider');
    selected.add(voice.provider);
    if (typeof voice.modelId !== 'string' || !voice.modelId.trim() || voice.modelId.length > 160 || typeof voice.voiceId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(voice.voiceId)) throw new Error('voice modelId/voiceId invalid');
    if (typeof voice.secretArn !== 'string' || !new RegExp(`^arn:aws:secretsmanager:${config.allowedRegion}:${config.teamAccountId}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`).test(voice.secretArn)) throw new Error('voice secretArn must be a complete Secrets Manager ARN in the confirmed account and region');
    if (voice.provider !== 'minimax' && voice.minimaxRegion !== undefined || voice.provider === 'minimax' && voice.minimaxRegion !== undefined && !['global','china'].includes(voice.minimaxRegion)) throw new Error('minimaxRegion must be global or china only for MiniMax');
    if (voice.provider !== 'stepfun' && voice.stepfunApiVariant !== undefined || voice.provider === 'stepfun' && voice.stepfunApiVariant !== undefined && !['openapi','step-plan'].includes(voice.stepfunApiVariant)) throw new Error('stepfunApiVariant must be openapi or step-plan only for StepFun');
  }
  if (config.polly !== undefined && (!config.polly || config.polly.region !== config.allowedRegion || config.polly.engine !== 'neural' || config.polly.voiceId !== 'Zhiyu' || Object.keys(config.polly).some(key => !['region','engine','voiceId'].includes(key)))) throw new Error('polly must explicitly select the allowedRegion, neural engine and Zhiyu voice');
  if (fixture) {
    if (process.env.COURTLENS_SYNTH_FIXTURE !== '1' || !config.fixtureOnly || config.contestConfigConfirmed) throw new Error('Offline fixture requires an explicit fixture flag and cannot be formal-ready');
  } else {
    if (config.fixtureOnly || !config.contestConfigConfirmed || config.portalEvidence === 'LOCAL_SYNTH_FIXTURE_ONLY') throw new Error('Formal deployment requires Portal-confirmed non-fixture configuration');
    if (config.teamAccountId === '111111111111' || config.operatorEmail.endsWith('.invalid')) throw new Error('Fixture account/email cannot be deployed');
  }
}
