const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(process.env.RUNTIME_NODE_MODULES||'','playwright'));}
const ROOT=path.resolve(__dirname,'..');
const BASE=process.env.BROADCAST_TEST_URL||'http://127.0.0.1:8770/broadcast/';
const OUT=path.join(ROOT,'workspace/broadcast-capability-browser');
(async()=>{
  await fs.mkdir(OUT,{recursive:true});
  const browser=await playwright.chromium.launch({headless:true,...(process.env.BROADCAST_BROWSER_EXECUTABLE?{executablePath:process.env.BROADCAST_BROWSER_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let providers=[
    {id:'stepfun-vision',kind:'semantic',configured:true,available:true,verified:false,modalities:['image','text'],mode:'stepfun-vision-frames'},
    {id:'stepfun-story',kind:'semantic',configured:true,available:true,verified:false,modalities:['text'],mode:'stepfun-story-text'},
  ];
  await page.route('**/api/broadcast/v1/capabilities',async route=>{
    const response=await route.fetch(),body=await response.json();body.data.providers=providers;
    await route.fulfill({response,json:body});
  });
  try{
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:/开始一个新回合/}).click();
    await page.locator('[data-form="create-project"] [name="title"]').fill('能力选择专项验收');
    await page.locator('[data-form="create-project"] [name="mode"]').selectOption('assisted');
    await page.locator('[data-form="create-project"] button[type="submit"]').click();
    await page.waitForSelector('[data-form="upload"]');
    await page.locator('[data-form="upload"] [name="video"]').setInputFiles(path.join(ROOT,'media/demo.mp4'));
    await page.locator('[data-form="upload"] [name="sourceKind"]').selectOption('synthetic');
    await page.locator('[data-form="upload"] [name="sourceLabel"]').fill('CourtLens 自制合成演练片');
    await page.locator('[data-form="upload"] [name="rightsNote"]').fill('仅用于本地界面验收');
    await page.locator('[data-form="upload"] button[type="submit"]').click();
    await page.waitForSelector('[data-form="analyze"]',{timeout:60000});
    let options=await page.locator('[data-form="analyze"] option').allTextContents();
    assert.deepEqual(options,['阶跃星辰 · 取证帧理解 · 尚未实测']);
    assert.equal(await page.locator('[data-form="analyze"] option').first().getAttribute('data-strategy'),'frames-first');
    assert.deepEqual(await page.locator('[data-form="analyze"] input[type="number"]').evaluateAll(inputs=>inputs.map(input=>input.value)),['0','36']);
    await page.locator('[data-form="analyze"] [name="scopeStart"]').fill('4.5');
    await page.locator('[data-form="analyze"] [name="scopeEnd"]').fill('6.5');
    assert.match(await page.locator('#analysis-window-hint').innerText(),/00:04\.5—00:06\.5.*48 秒/);
    await page.locator('.step-nav [data-step="2"]').click();
    assert.equal(await page.locator('[data-action="model-story"][data-provider="stepfun-story"]').count(),1);
    assert.equal(await page.locator('[data-action="model-story"][data-provider="stepfun-story"]').isDisabled(),true);
    await page.locator('.step-nav [data-step="1"]').click();
    assert.deepEqual(await page.locator('[data-form="analyze"] input[type="number"]').evaluateAll(inputs=>inputs.map(input=>input.value)),['4.5','6.5']);
    await page.locator('.step-nav [data-step="2"]').click();
    await page.screenshot({path:path.join(OUT,'stepfun-story-disabled-until-evidence.png')});
    await page.locator('.step-nav [data-step="1"]').click();
    await page.locator('#source-seek').fill('5');
    await page.locator('[data-action="capture-frame"]').click();
    await page.locator('.frame-drawer summary').click();
    await page.waitForSelector('.frame-thumb');
    const observe=page.locator('[data-form="observation"]');
    await observe.locator('[name="type"]').selectOption('movement');
    await observe.locator('[name="start"]').fill('4.5');
    await observe.locator('[name="end"]').fill('5.5');
    await observe.locator('[name="anchorTime"]').fill('5');
    await observe.locator('[name="description"]').fill('合成演练画面可见球员移动。');
    await observe.locator('[name="frameId"]').first().check();
    await observe.locator('[name="actor"]').fill('界面验收员');
    await observe.locator('button[type="submit"]').click();
    await page.waitForSelector('[data-action="accept-observation"]');
    await page.locator('[data-form="observation"] [name="actor"]').fill('界面验收员');
    await page.locator('[data-action="accept-observation"]').click();
    await page.waitForFunction(()=>document.querySelector('.record.selected .tag')?.textContent.includes('已接受'));
    await page.locator('.step-nav [data-step="2"]').click();
    assert.equal(await page.locator('[data-action="model-story"][data-provider="stepfun-story"]').isEnabled(),true);
    let storyRequest=null,storyRevision=null,jobPolls=0;
    await page.route('**/api/broadcast/v1/projects/*/story',async route=>{
      storyRequest=route.request().postDataJSON();
      const response=await route.fetch({postData:JSON.stringify({...storyRequest,mode:'template',providerId:null})});
      assert.equal(response.status(),200);
      storyRevision=(await response.json()).data.revision;
      await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({data:{id:'ui-story-job',type:'model-story',status:'queued',stage:'queued',progress:null}})});
    });
    await page.route('**/api/broadcast/v1/jobs/ui-story-job',async route=>{
      jobPolls++;
      const status=jobPolls===1?'running':'succeeded';
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{id:'ui-story-job',type:'model-story',status,stage:status==='running'?'draft':'done',progress:null,result:status==='succeeded'?{projectId:'ui-test',projectRevision:storyRevision}:null}})});
    });
    await page.locator('[data-action="model-story"][data-provider="stepfun-story"]').click();
    await page.waitForSelector('[data-form="story"]',{timeout:12000});
    assert.equal(storyRequest?.mode,'model');
    assert.equal(storyRequest?.providerId,'stepfun-story');
    assert.ok(jobPolls>=2);
    assert.match(await page.locator('.step-nav [data-step="2"]').getAttribute('class'),/active/);
    providers=[
      {id:'agentcore-proposal',kind:'semantic',configured:true,available:true,verified:false,modalities:['video','image','text'],mode:'agentcore-runtime'},
      {id:'agentcore-story',kind:'semantic',configured:true,available:true,verified:false,modalities:['text'],mode:'agentcore-runtime'},
    ];
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('.step-nav [data-step="1"]').click();
    options=await page.locator('[data-form="analyze"] option').allTextContents();
    assert.deepEqual(options,[
      '云端视觉辅助 · 视频片段理解 · 尚未实测',
      '云端视觉辅助 · 取证帧理解 · 尚未实测',
    ]);
    assert.equal(await page.locator('[data-form="analyze"] option').nth(1).getAttribute('data-strategy'),'frames-first');
    assert.equal(await page.locator('[data-form="analyze"] option').count(),2);
    let submitted=null;
    await page.route('**/api/broadcast/v1/projects/*/analyze',async route=>{
      submitted=route.request().postDataJSON();
      await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({data:{id:'ui-test-job',type:'analyze',status:'queued',stage:'queued',progress:null}})});
    });
    await page.locator('[data-form="analyze"] [name="analysisChoice"]').selectOption('agentcore-proposal::frames-first');
    await page.locator('[data-form="analyze"] [name="scopeStart"]').fill('2.25');
    await page.locator('[data-form="analyze"] [name="scopeEnd"]').fill('8.5');
    const submittedResponse=page.waitForResponse(response=>response.url().endsWith('/analyze')&&response.status()===202);
    await page.locator('[data-form="analyze"] button[type="submit"]').click();
    await submittedResponse;
    assert.equal(submitted?.providerId,'agentcore-proposal');
    assert.equal(submitted?.strategy,'frames-first');
    assert.deepEqual(submitted?.scope,{start:2.25,end:8.5});
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(OUT,'cloud-two-real-modalities.png')});
    console.log(JSON.stringify({stepfunVisual:'frames-first only',stepfunStory:'separate and evidence-gated',modelStoryJobPolls:jobPolls,modelStoryCompletedInEditor:true,cloudStrategies:options,pageErrors:errors},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
