import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('offline synth contains private origin, AgentCore and bounded CPU workflow', () => {
  const run = spawnSync(process.execPath, ['scripts/entry.mjs', 'synth'], {cwd:root,encoding:'utf8'});
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  const metadata = JSON.parse(readFileSync(path.join(root,'cdk.out','CourtLensBroadcast.metadata.json')));
  assert.ok(!Object.values(metadata).flat().some(item => item.type === 'aws:cdk:error'), 'synth contains CDK error annotation');
  const template = JSON.parse(readFileSync(path.join(root,'cdk.out','CourtLensBroadcast.template.json')));
  const resources = Object.values(template.Resources);
  const byType = type => resources.filter(item => item.Type === type);
  const buckets = byType('AWS::S3::Bucket');
  assert.equal(buckets.length, 2);
  for (const bucket of buckets) {
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true,
    });
  }
  assert.ok(byType('AWS::CloudFront::OriginAccessControl').length >= 1);
  assert.equal(byType('AWS::BedrockAgentCore::Runtime').length, 1);
  assert.equal(byType('AWS::Cognito::UserPool').length, 1);
  assert.equal(byType('AWS::DynamoDB::Table').length, 1);
  assert.equal(byType('AWS::StepFunctions::StateMachine').length, 1);
  const ecs = byType('AWS::ECS::TaskDefinition')[0];
  assert.equal(ecs.Properties.Cpu, '2048');
  assert.equal(ecs.Properties.RuntimePlatform.CpuArchitecture, 'X86_64');
  assert.equal(ecs.Properties.RequiresCompatibilities[0], 'FARGATE');
  assert.ok(!ecs.Properties.ContainerDefinitions[0].Secrets?.length, 'voice secrets are absent by default');
  const sm = byType('AWS::StepFunctions::StateMachine')[0];
  assert.equal(sm.Properties.StateMachineType, 'STANDARD');
  assert.ok(resources.some(item => item.Type === 'AWS::ApiGateway::Authorizer'));
  const imageFunctions = byType('AWS::Lambda::Function').filter(item => item.Properties.PackageType === 'Image');
  assert.equal(imageFunctions.length, 1, 'API must carry Node metrics validator in a Lambda container');
  assert.match(JSON.stringify(template), /states:StopExecution/, 'cancellation needs a scoped StopExecution permission');
  const assets = JSON.parse(readFileSync(path.join(root,'cdk.out','CourtLensBroadcast.assets.json')));
  for (const image of Object.values(assets.dockerImages)) {
    const staged = path.join(root,'cdk.out',image.source.directory);
    const entries = readdirSync(staged,{recursive:true}).map(String);
    assert.ok(!entries.some(item => /(^|\/)(\.env[^/]*|\.venv|node_modules)(\/|$)/.test(item)), 'container context contains secret or local dependency directory');
  }
});

test('optional MiniMax and StepFun keys are injected only into the task from scoped Secrets Manager ARNs', () => {
  const temp = mkdtempSync(path.join(tmpdir(),'courtlens-voice-test-'));
  try {
    const cfg = JSON.parse(readFileSync(path.join(root,'config.fixture.json')));
    cfg.voiceProviders = [
      {provider:'minimax',modelId:'fixture-minimax-model',voiceId:'fixture-minimax-voice',secretArn:'arn:aws:secretsmanager:us-west-2:111111111111:secret:courtlens/minimax-ABC123',minimaxRegion:'global'},
      {provider:'stepfun',modelId:'fixture-stepfun-model',voiceId:'fixture-stepfun-voice',secretArn:'arn:aws:secretsmanager:us-west-2:111111111111:secret:courtlens/stepfun-DEF456',stepfunApiVariant:'step-plan'},
    ];
    const configPath = path.join(temp,'fixture.json');
    writeFileSync(configPath,JSON.stringify(cfg));
    const run = spawnSync(process.execPath,[path.join(root,'node_modules','aws-cdk','bin','cdk'),'synth','--output',path.join(temp,'cdk.out')],
      {cwd:root,encoding:'utf8',env:{...process.env,COURTLENS_CONFIG_FILE:configPath,COURTLENS_SYNTH_FIXTURE:'1',AWS_REGION:'us-west-2',AWS_DEFAULT_REGION:'us-west-2'}});
    assert.equal(run.status,0,run.stderr.slice(-2000));
    const template = JSON.parse(readFileSync(path.join(temp,'cdk.out','CourtLensBroadcast.template.json')));
    const task = Object.values(template.Resources).find(item => item.Type === 'AWS::ECS::TaskDefinition');
    const secrets = task.Properties.ContainerDefinitions[0].Secrets;
    assert.deepEqual(secrets.map(row => row.Name).sort(),['COURTLENS_MINIMAX_API_KEY','COURTLENS_STEPFUN_API_KEY']);
    const serialized = JSON.stringify(template);
    assert.match(serialized,/courtlens\/minimax-ABC123/);
    assert.match(serialized,/courtlens\/stepfun-DEF456/);
    assert.match(serialized,/secretsmanager:GetSecretValue/);
    assert.match(serialized,/VOICE_PROVIDER_IDS/);
    assert.match(serialized,/COURTLENS_STEPFUN_API_VARIANT/);
    assert.match(serialized,/step-plan/);
    const secretStatements = Object.values(template.Resources).filter(item => item.Type === 'AWS::IAM::Policy')
      .flatMap(item => item.Properties.PolicyDocument.Statement)
      .filter(statement => [statement.Action].flat().includes('secretsmanager:GetSecretValue'));
    assert.ok(secretStatements.length >= 1);
    assert.ok(secretStatements.every(statement => JSON.stringify(statement.Resource) !== '"*"' &&
      JSON.stringify(statement.Resource).includes('arn:aws:secretsmanager:us-west-2:111111111111:secret:courtlens/')),
      'voice read policies must be scoped to the configured secrets');
  } finally {
    rmSync(temp,{recursive:true,force:true});
  }
});

test('fixture cannot pass the formal validation entry', () => {
  const run = spawnSync(process.execPath, ['scripts/entry.mjs', 'validate'], {cwd:root,encoding:'utf8',env:{...process.env,COURTLENS_CONFIG_FILE:path.join(root,'config.fixture.json')}});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Formal config blocked/);
});
