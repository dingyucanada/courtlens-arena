const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.RUNTIME_NODE_MODULES || '', 'playwright')); }
const {chromium} = playwright;
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BROADCAST_TEST_URL || 'http://127.0.0.1:8769/broadcast/';
const OUT = path.resolve(process.env.BROADCAST_TEST_OUTPUT || path.join(ROOT, 'workspace', 'broadcast-browser-tests'));

(async () => {
  await fs.mkdir(OUT, {recursive:true});
  const browser=await chromium.launch({headless:true,...(process.env.BROADCAST_BROWSER_EXECUTABLE?{executablePath:process.env.BROADCAST_BROWSER_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
  const errors=[],checks=[];
  page.on('pageerror',error=>errors.push(error.message));
  const pass=(name,value={})=>checks.push({name,value});
  const resetScroll=()=>page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';document.body.style.scrollBehavior='auto';document.scrollingElement.scrollTop=0;window.scrollTo(0,0);});
  const assertDecoded=async (label,at)=>{
    await page.locator('#broadcast-video').evaluate((video,seconds)=>new Promise(resolve=>{
      if(Math.abs(video.currentTime-seconds)<.01&&video.readyState>=2&&!video.seeking){resolve();return;}
      video.addEventListener('seeked',resolve,{once:true});video.currentTime=seconds;
    }),at);
    const pixels=await page.waitForFunction(()=>{
      const video=document.querySelector('#broadcast-video');if(!video||video.readyState<2||video.seeking||!video.videoWidth)return false;
      const canvas=document.createElement('canvas');canvas.width=16;canvas.height=9;
      const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(video,0,0,16,9);
      const bytes=context.getImageData(0,0,16,9).data,colors=[];
      for(let i=0;i<bytes.length;i+=4)colors.push(`${bytes[i]},${bytes[i+1]},${bytes[i+2]}`);
      return new Set(colors).size>8 ? Array.from(bytes.slice(4*70,4*70+3)) : false;
    },null,{timeout:30000});
    pass(label,{sample:await pixels.jsonValue()});
  };
  try {
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    await page.waitForSelector('[data-action="new-project"]',{timeout:20000});
    await page.getByRole('button',{name:/开始一个新回合/}).click();
    await page.locator('[data-form="create-project"] [name="title"]').fill('合成演练｜一次进攻的选择');
    await page.locator('[data-form="create-project"] button[type="submit"]').click();
    await page.waitForSelector('[data-form="upload"]');
    pass('project-created',await page.locator('.project-meta h1').innerText());

    await page.locator('[data-form="upload"] [name="video"]').setInputFiles(path.join(ROOT,'media','demo.mp4'));
    await page.locator('[data-form="upload"] [name="sourceKind"]').selectOption('synthetic');
    await page.locator('[data-form="upload"] [name="sourceLabel"]').fill('CourtLens 本地合成演练片');
    await page.locator('[data-form="upload"] [name="rightsNote"]').fill('仅用于本机产品流程验收');
    await page.locator('[data-form="upload"] button[type="submit"]').click();
    await page.waitForSelector('#broadcast-video',{timeout:60000});
    await page.waitForFunction(()=>document.querySelector('#broadcast-video')?.readyState>=2,{timeout:30000});
    const media=await page.locator('#broadcast-video').evaluate(video=>({duration:video.duration,width:video.videoWidth,height:video.videoHeight}));
    assert.ok(media.duration>0&&media.width>0);pass('real-media-upload-and-decode',media);
    await assertDecoded('source-has-decoded-image',0.8);
    await page.locator('#broadcast-video').evaluate(video=>{window.retainedVideo=video;window.mediaLoads=0;video.pause();video.currentTime=5;video.addEventListener('loadstart',()=>window.mediaLoads++);});
    await page.waitForFunction(()=>!document.querySelector('#broadcast-video').seeking);
    for(const step of ['0','1','2','3','1']){
      await page.locator(`.step-nav [data-step="${step}"]`).click();
      const retained=await page.evaluate(()=>({same:window.retainedVideo===document.querySelector('#broadcast-video'),connected:window.retainedVideo.isConnected,time:window.retainedVideo.currentTime,paused:window.retainedVideo.paused,loads:window.mediaLoads}));
      assert.ok(retained.same&&retained.connected&&retained.paused&&Math.abs(retained.time-5)<.1&&retained.loads===0,JSON.stringify(retained));
      assert.equal(await page.locator('.panel-head h2').innerText(),['选片','看懂','讲清','出片'][Number(step)]);
    }
    pass('panels-preserve-connected-video-and-paused-time',{loads:0});
    await page.locator('#broadcast-video').evaluate(video=>video.play());
    const playingTime=await page.locator('#broadcast-video').evaluate(video=>video.currentTime);
    await page.locator('.step-nav [data-step="0"]').click();
    await page.waitForTimeout(250);
    assert.ok(await page.evaluate(()=>window.retainedVideo===document.querySelector('#broadcast-video')&&!window.retainedVideo.paused&&window.mediaLoads===0));
    assert.ok(await page.locator('#broadcast-video').evaluate((video,start)=>video.currentTime>start,playingTime));
    await page.locator('#broadcast-video').evaluate(video=>video.pause());
    await page.locator('.step-nav [data-step="1"]').click();
    pass('panel-change-preserves-playing-video',{loads:0});

    await page.locator('#notice [data-action="dismiss-notice"]').click().catch(()=>{});
    await resetScroll();
    const stageBounds=await page.locator('.stage').boundingBox(),timelineBounds=await page.locator('.timeline').boundingBox(),seekBounds=await page.locator('#source-seek').boundingBox();
    assert.ok(stageBounds.y>0&&stageBounds.y+stageBounds.height<900&&seekBounds.y+seekBounds.height<=900,`first-screen stage/seek ${stageBounds.y}/${stageBounds.y+stageBounds.height}/${seekBounds.y+seekBounds.height}`);
    pass('studio-video-and-timeline-first-screen',{videoBottom:Math.round(stageBounds.y+stageBounds.height),seekBottom:Math.round(seekBounds.y+seekBounds.height),timelineBottom:Math.round(timelineBounds.y+timelineBounds.height)});
    const panelScroll=await page.evaluate(()=>{const el=document.querySelector('.work-panel');return {client:el.clientHeight,content:el.scrollHeight,overflow:getComputedStyle(el).overflowY};});
    assert.ok(panelScroll.content>panelScroll.client&&panelScroll.overflow==='auto');pass('independent-task-scroll',panelScroll);
    const isolatedScroll=await page.evaluate(()=>{const panel=document.querySelector('.work-panel'),stage=document.querySelector('.stage');const before={stageY:stage.getBoundingClientRect().y,pageY:window.scrollY};panel.scrollTop=220;const after={stageY:stage.getBoundingClientRect().y,pageY:window.scrollY,panelY:panel.scrollTop};panel.scrollTop=0;return {before,after};});
    assert.ok(isolatedScroll.after.panelY>0&&Math.abs(isolatedScroll.after.stageY-isolatedScroll.before.stageY)<1&&isolatedScroll.after.pageY===isolatedScroll.before.pageY,JSON.stringify(isolatedScroll));
    await resetScroll();
    await page.screenshot({path:path.join(OUT,'studio-desktop.png'),fullPage:false});

    await page.locator('#source-seek').fill('5');
    await page.locator('[data-action="capture-frame"]').click();
    await page.locator('.frame-drawer summary').click();
    await page.waitForSelector('.frame-thumb',{timeout:20000});
    pass('actual-frame',await page.locator('.frame-thumb span').first().innerText());
    const observe=page.locator('[data-form="observation"]');
    await observe.locator('[name="type"]').selectOption('movement');
    await observe.locator('[name="start"]').fill('4.50');
    await observe.locator('[name="end"]').fill('5.50');
    await observe.locator('[name="anchorTime"]').fill('5.00');
    await observe.locator('[name="description"]').fill('合成画面中可见球员在场上移动。');
    await observe.locator('[name="frameId"]').first().check();
    await observe.locator('[name="actor"]').fill('浏览器验收员');
    await observe.locator('button[type="submit"]').click();
    await page.waitForSelector('[data-action="accept-observation"]');
    await page.locator('[data-form="observation"] [name="actor"]').fill('浏览器验收员');
    await page.locator('[data-action="accept-observation"]').click();
    await page.waitForFunction(()=>document.querySelector('.record.selected .tag')?.textContent.includes('已接受'));
    pass('human-observation-accepted',{});
    await page.screenshot({path:path.join(OUT,'observe-desktop.png'),fullPage:true});

    await page.locator('.step-nav [data-step="2"]').click();
    await page.locator('[data-action="template-story"]').click();
    await page.waitForSelector('[data-form="story"]');
    const beatCount=await page.locator('.beat-list .record').count();
    assert.ok(beatCount>=1&&beatCount<=3);pass('source-timed-story',{beatCount});
    await page.locator('.beat-list .record').first().click();
    await page.waitForFunction(()=>{const overlay=document.querySelector('#draft-overlay');return overlay&&!overlay.hidden&&document.querySelector('#draft-caption')?.textContent?.trim();});
    pass('live-draft-caption',await page.locator('#draft-caption').innerText());
    await page.locator('#annotation-actor').fill('浏览器验收员');
    await page.locator('[data-action="start-annotation"]').click();
    await page.waitForSelector('.annotation-layer');
    const surface=await page.locator('.annotation-layer').boundingBox();
    await page.mouse.click(surface.x+surface.width*.34,surface.y+surface.height*.54);
    await page.mouse.click(surface.x+surface.width*.62,surface.y+surface.height*.5);
    await page.waitForSelector('[data-action="clear-annotation"]',{timeout:20000});
    pass('reviewed-manual-arrow',{});
    await page.locator('.beat-list .record').first().click();
    await page.waitForFunction(()=>{const arrow=document.querySelector('#draft-arrow');return arrow&&!arrow.hidden;});
    pass('time-bound-arrow-preview',{});
    assert.equal(await page.locator('.annotation-reference').count(),0,'frozen annotation frame must be removed after saving');
    await assertDecoded('story-has-decoded-image-after-arrow-save',5.7);
    await resetScroll();
    await page.locator('#notice [data-action="dismiss-notice"]').click().catch(()=>{});
    await page.screenshot({path:path.join(OUT,'story-desktop.png'),fullPage:false});

    await page.locator('.step-nav [data-step="3"]').click();
    const review=page.locator('[data-form="review"]');
    await review.locator('[name="actor"]').fill('浏览器验收员');
    for(const name of ['identity','timing','metrics','wording','geometry'])await review.locator(`[name="${name}"]`).check();
    await review.locator('button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('.status-pill.good')?.textContent.includes('已人工审核'),null,{timeout:20000});
    pass('human-review',{});
    await page.locator('[data-form="render"] button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('.job-status')?.textContent.includes('已完成'),null,{timeout:180000});
    await page.locator('.job-status [data-action="watch-release"]').click();
    await page.waitForURL(/release=/,{timeout:20000});
    await page.waitForSelector('#broadcast-video');
    await page.waitForFunction(()=>document.querySelector('#broadcast-video')?.readyState>=2,null,{timeout:30000});
    pass('real-mp4-release',{url:page.url(),duration:await page.locator('#broadcast-video').evaluate(v=>v.duration)});
    await page.screenshot({path:path.join(OUT,'watch-desktop.png'),fullPage:true});

    await page.locator('#broadcast-video').evaluate(v=>{v.currentTime=Math.min(3,v.duration/2);v.pause();});
    const enhancedTime=await page.locator('#broadcast-video').evaluate(v=>v.currentTime);
    await page.locator('[data-action="watch-mode"][data-mode="original"]').click();
    await page.waitForFunction(()=>document.querySelector('#broadcast-video')?.readyState>=2);
    const originalTime=await page.locator('#broadcast-video').evaluate(v=>v.currentTime);
    assert.ok(Math.abs(originalTime-enhancedTime)<.25,`source-time switch ${enhancedTime} -> ${originalTime}`);
    pass('original-enhanced-source-time',{enhancedTime,originalTime});
    await page.locator('[data-action="open-evidence"]').click();
    await page.waitForSelector('.evidence-drawer');
    assert.match(await page.locator('.evidence-drawer').innerText(),/人工已接受|源片画面/);
    pass('immutable-release-evidence',{});
    await page.locator('[data-action="close-evidence"]').last().click();
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.querySelector('#broadcast-video')?.readyState>=2);
    await page.screenshot({path:path.join(OUT,'watch-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    pass('mobile-no-horizontal-overflow',{});
    await page.route('**/api/broadcast/v1/capabilities',async route=>{
      const response=await route.fetch(),body=await response.json();
      body.data.renderer.available=false;
      await route.fulfill({response,json:body});
    });
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    await page.waitForSelector('.studio-header');
    await page.locator('.step-nav [data-step="3"]').click();
    assert.equal(await page.locator('[data-form="render"] button[type="submit"]').isDisabled(),true);
    assert.match(await page.locator('.work-panel').innerText(),/成片服务不可用/);
    pass('unavailable-renderer-disables-export',{});
    await page.unroute('**/api/broadcast/v1/capabilities');
    await page.locator('.step-nav [data-step="2"]').click();
    const textField=page.locator('[data-form="story"] [name="beatText"]');
    await textField.fill((await textField.inputValue())+' 回看这一段。');
    await page.locator('[data-form="story"] button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('.status-pill.warn')?.textContent.includes('需重新审核'));
    await page.locator('.step-nav [data-step="3"]').click();
    assert.ok(await page.locator('.release-list .record').count()>0);
    pass('edit-revokes-review-preserves-release',{});
    assert.deepEqual(errors,[]);pass('browser-page-errors',errors);
  } catch(error) {
    await fs.writeFile(path.join(OUT,'failure.txt'),error.stack);
    await page.screenshot({path:path.join(OUT,'failure.png'),fullPage:true});
    throw error;
  } finally {
    await fs.writeFile(path.join(OUT,'results.json'),JSON.stringify({checks,errors},null,2));
    await browser.close();
  }
  console.log(JSON.stringify({passed:checks.length,checks}));
})().catch(error=>{console.error(error);process.exitCode=1;});
