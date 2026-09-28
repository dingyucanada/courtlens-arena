import test from 'node:test';
import assert from 'node:assert/strict';
import {filmFilename,localArtifactLink} from '../pro/delivery.mjs';
test('video delivery names preserve Chinese and exclude path/control characters',()=>{assert.equal(filmFilename('火箭/独行侠:复盘\n'), '火箭-独行侠-复盘--战术故事.webm');assert.equal(filmFilename('',true),'CourtLens-战术故事.mp4');assert.ok(filmFilename('比'.repeat(1000)).length<120);});
test('local artifact response must reference the exact same-origin route and content digest',()=>{const value={url:'/api/arena/artifacts/'+'a'.repeat(32)+'/video',bytes:12,sha256:'b'.repeat(64)};assert.equal(localArtifactLink(value),value.url);for(const patch of [{url:'https://other.example/video'},{url:'/api/arena/artifacts/../video'},{bytes:0},{bytes:1.5},{sha256:'broken'}])assert.throws(()=>localArtifactLink({...value,...patch}));});
