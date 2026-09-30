import { App } from 'aws-cdk-lib';
import { readConfig } from '../lib/config.js';
import { BroadcastStack } from '../lib/stack.js';

const config = readConfig();
const app = new App();
new BroadcastStack(app, 'CourtLensBroadcast', {
  env: { account: config.teamAccountId, region: config.allowedRegion },
  config,
});
app.synth();
