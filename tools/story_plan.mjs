#!/usr/bin/env node
/** Prepare, import, review, revise and verify a portable editorial plan. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseInput} from '../pro/model.mjs';
import {createLocalStoryPlan,createStoryPlan,reviewStoryPlan,reviseStoryPlan,verifyStoryPlan,storyTimeMap} from '../pro/story-plan.mjs';

const args=process.argv.slice(2),command=args[0];
const option=(key,fallback=null)=>{const i=args.indexOf(key);if(i>=0&&(!args[i+1]||args[i+1].startsWith('--')))throw new Error(`${key} requires a value.`);return i<0?fallback:args[i+1];};
const read=async file=>JSON.parse(await fs.readFile(path.resolve(file),'utf8'));
async function write(plan){const output=option('--output');if(!output)throw new Error('--output is required; original files are never overwritten.');await fs.writeFile(path.resolve(output),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output:path.resolve(output),planHash:plan.planHash,contentHash:plan.contentHash,review:plan.review.status}));}
try{
  if(args.includes('--help')||!command){console.log('StoryPlan CLI\n  create --project project.json --output draft.json\n  import --project project.json --proposal proposal.json --provider provider --model model --prompt prompt.txt --output draft.json\n  review --plan draft.json --reviewer name --reason note --output reviewed.json\n  revise --plan reviewed.json --changes changes.json --output revised.json\n  validate --plan reviewed.json [--require-reviewed]\nReview records a human decision; it does not run a model or authenticate footage.');}
  else if(command==='create'||command==='import'){
    const filename=option('--project');if(!filename)throw new Error('--project required.');const project=parseInput(await fs.readFile(path.resolve(filename),'utf8'),path.basename(filename)).project;
    const promptFile=option('--prompt'),prompt=promptFile?await fs.readFile(path.resolve(promptFile),'utf8'):'';
    if(command==='create')await write(await createLocalStoryPlan(project,{prompt,question:option('--question','')}));
    else{const provider=option('--provider'),model=option('--model');if(!provider||!model||!promptFile)throw new Error('An external proposal requires --provider, --model and --prompt provenance.');await write(await createStoryPlan(project,await read(option('--proposal')),{generation:{kind:'external-model',provider,model,promptVersion:option('--prompt-version','story-plan/1'),prompt,request:{question:option('--question','')}}}));}
  }else if(command==='review')await write(await reviewStoryPlan(await read(option('--plan')),{reviewer:option('--reviewer'),reason:option('--reason','Source anchors, final prose and arrows reviewed.')}));
  else if(command==='revise')await write(await reviseStoryPlan(await read(option('--plan')),await read(option('--changes')),{actor:option('--actor','manual editor')}));
  else if(command==='validate'){const plan=await read(option('--plan'));console.log(JSON.stringify({...await verifyStoryPlan(plan,plan.inputSnapshot.project,{requireReviewed:args.includes('--require-reviewed')}),planHash:plan.planHash,timeMap:storyTimeMap(plan)}));}
  else throw new Error('Unknown command. Use --help.');
}catch(error){console.error(error.message);process.exitCode=1;}
