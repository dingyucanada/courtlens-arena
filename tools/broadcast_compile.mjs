#!/usr/bin/env node
/** Narrow bridge to the existing metrics-v2 validator; never inject evidence. */
import fs from 'node:fs';
import {validateMetricBundle} from '../pro/metrics-v2.mjs';
const command=process.argv[2];
try {
  if(command!=='validate-metrics')throw new Error('Unsupported command');
  const input=fs.readFileSync(0,'utf8');
  if(input.length>8*1024*1024)throw new Error('Metrics request too large');
  validateMetricBundle(JSON.parse(input));
  process.stdout.write(JSON.stringify({ok:true}));
} catch(error) {
  process.stderr.write(String(error.message).slice(0,1200));
  process.exitCode=1;
}
