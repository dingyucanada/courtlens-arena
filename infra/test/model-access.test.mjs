import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('model modalities and tool support must be explicitly declared without inferring from an ID', () => {
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import configModule from './lib/config.ts';
    const {validateConfig}=configModule;
    const cfg=JSON.parse(fs.readFileSync('./config.fixture.json','utf8'));
    validateConfig(cfg,true);
    validateConfig({...cfg,portalConfirmedModelId:'fixture-235b',portalConfirmedModelModalities:['text'],portalConfirmedToolUse:false},true);
    for(const values of [undefined,[],['text','audio'],['text','text'],['video'],['text','video']])
      assert.throws(()=>validateConfig({...cfg,portalConfirmedModelModalities:values},true));
    for(const value of [undefined,'true',1,null])
      assert.throws(()=>validateConfig({...cfg,portalConfirmedToolUse:value},true));
  `;
  const run=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',source],
    {cwd:root,encoding:'utf8',env:{...process.env,COURTLENS_SYNTH_FIXTURE:'1'}});
  assert.equal(run.status,0,run.stderr);
});
