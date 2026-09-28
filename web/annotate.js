'use strict';
(()=>{
 const $=id=>document.getElementById(id),film=$('film'),canvas=$('canvas');
 const state={project:null,points:[],dirty:false,bound:false,hash:null};
 const id=new URL(location.href).searchParams.get('project');
 function message(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error)}
 async function api(url,body){const r=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data}
 function p(){return state.project?.dataset.possessions.find(p=>p.id===$('possession').value)}
 function sync(){if(!state.project)return;const r=CourtLensMedia.check(state.project.dataset.video,{ready:film.readyState>=1,sha256:state.hash,width:film.videoWidth,height:film.videoHeight,duration:film.duration});state.bound=r.ok;$('binding').textContent=r.message;draw()}
 function svg(tag,attrs,text){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text)n.textContent=text;return n}
 function draw(){
  canvas.replaceChildren();$('clock').textContent=film.currentTime.toFixed(2)+' 秒';if(!state.bound||!p())return;
  const {width:w,height:h}=state.project.dataset.video;canvas.setAttribute('viewBox',`0 0 ${w} ${h}`);
  const defs=svg('defs',{}),marker=svg('marker',{id:'arrow-tip',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto'});marker.append(svg('path',{d:'M0 0L10 5L0 10z',fill:'#8bb6ff'}));defs.append(marker);canvas.append(defs);
  for(const a of p().annotations.filter(a=>a.start<=film.currentTime&&film.currentTime<a.end)){
   const points=a.points.map(([x,y])=>[x*w,y*h]);const attr={points:points.map(v=>v.join(',')).join(' '),stroke:'#8bb6ff','stroke-width':3,fill:a.kind==='zone'?'#8bb6ff33':'none'};
   if(a.kind==='arrow')attr['marker-end']='url(#arrow-tip)';if(a.kind!=='label')canvas.append(svg(a.kind==='zone'?'polygon':'polyline',attr));
   canvas.append(svg('text',{x:points[0][0]+8,y:Math.max(25,points[0][1]-12),fill:'#d1e0f4','font-size':22},(a.origin==='manual'?'人工 · ':'')+a.label));
  }
  state.points.forEach(([x,y])=>canvas.append(svg('circle',{cx:x*w,cy:y*h,r:7,fill:'#f6b777',stroke:'#fff','stroke-width':2})));
 }
 function list(){const box=$('annotations');box.replaceChildren();if(!p())return;for(const a of p().annotations){const row=document.createElement('div'),text=document.createElement('span'),b=document.createElement('button');text.textContent=`${a.origin==='manual'?'人工':'输入'} · ${a.label} · ${a.start.toFixed(2)}–${a.end.toFixed(2)}秒`;b.textContent='移除';b.addEventListener('click',()=>{p().annotations=p().annotations.filter(n=>n.id!==a.id);changed();list();draw()});row.append(text,b);box.append(row)}if(!box.childElementCount)box.textContent='尚无标注。'}
 function changed(){state.dirty=true;state.project.dataset.workflow={state:'draft'};$('save').disabled=false}
 function select(){state.points=[];$('reviewed').checked=false;const q=p();$('start').value=q.start.toFixed(2);$('end').value=Math.min(q.start+2,q.end).toFixed(2);film.currentTime=q.start;list();draw()}
 canvas.addEventListener('click',e=>{
  if(!state.bound)return message('视频尚未配对，无法标注。',true);
  if(!film.paused){film.pause();return message('视频已暂停。现在可以选点。')}
  if(!$('reviewed').checked)return message('请先核对时间段，并勾选镜头核对声明。',true);
  const rect=canvas.getBoundingClientRect();state.points.push([(e.clientX-rect.left)/rect.width,(e.clientY-rect.top)/rect.height]);
  const needed=$('kind').value==='label'?1:2;
  if(state.points.length===needed){try{const r=CourtLensAnnotation.create(p(),$('kind').value,$('label').value,Number($('start').value),Number($('end').value),state.points,crypto.randomUUID().replaceAll('-','').slice(0,12));p().annotations.push(r.annotation);p().camera_segments=r.camera_segments;changed();list();message('标注已加入。保存后可在复盘与成片中看到“人工”标签。')}catch(error){message(error.message,true)}state.points=[]}draw();
 });
 $('possession').addEventListener('change',select);$('kind').addEventListener('change',()=>{state.points=[];draw()});$('cancel-draw').addEventListener('click',()=>{state.points=[];draw()});
 $('toggle-play').addEventListener('click',async()=>{try{if(film.paused)await film.play();else film.pause()}catch{message('视频尚未就绪或浏览器不支持该格式',true)}});
 film.addEventListener('error',()=>{state.bound=false;draw();message('视频无法解码，请返回项目页重新导入可播放格式。',true)});
 $('back-frame').addEventListener('click',()=>{film.pause();film.currentTime=Math.max(0,film.currentTime-.1)});$('forward-frame').addEventListener('click',()=>{film.pause();film.currentTime=Math.min(film.duration,film.currentTime+.1)});
 $('use-time').addEventListener('click',()=>{if(!p())return;const t=Math.max(p().start,Math.min(film.currentTime,p().end-.05));$('start').value=t.toFixed(2);$('end').value=Math.min(t+2,p().end).toFixed(2);$('reviewed').checked=false});
 $('download-draft').addEventListener('click',()=>{if(!state.project)return;const url=URL.createObjectURL(new Blob([JSON.stringify(state.project.dataset,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='CourtLens-标注草稿.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000)});
 $('save').addEventListener('click',async()=>{if(!state.project)return;$('save').disabled=true;try{const r=await api('/api/projects/'+id+'/save',{name:state.project.name,dataset:state.project.dataset,expected_revision:state.project.revision});state.project=r.project;state.dirty=false;$('project-name').textContent=r.project.name+' · 版本 '+r.project.revision;message('已保存为版本 '+r.project.revision+'。请返回项目页整体复核后导出。')}catch(e){message(e.message+'；当前编辑仍保留在页面，版本冲突时请另存JSON或重新核对，避免覆盖其他窗口。',true);$('save').disabled=false}});
 film.addEventListener('loadedmetadata',()=>{$('stage').style.aspectRatio=film.videoWidth+'/'+film.videoHeight;sync()});film.addEventListener('timeupdate',draw);film.addEventListener('seeked',draw);film.addEventListener('play',()=>$('stage').classList.add('playing'));film.addEventListener('pause',()=>$('stage').classList.remove('playing'));
 window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue=''}});
 async function init(){try{if(!id)throw Error('请先从项目页选择一个项目。');const r=await api('/api/projects/'+encodeURIComponent(id));state.project=r.project;$('download-draft').disabled=false;$('project-name').textContent=r.project.name+' · 版本 '+r.project.revision;$('back-link').href='/projects.html?project='+id;for(const q of r.project.dataset.possessions){const op=document.createElement('option');op.value=q.id;op.textContent=q.title;$('possession').append(op)}if(!r.project.media)throw Error('此项目尚未导入视频。请返回项目页先导入。');film.src=r.project.media.url;select();const response=await fetch(r.project.media.url);if(!response.ok)throw Error('读取项目视频失败');const bytes=await response.arrayBuffer();state.hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');sync();message('先选择回合与标注区间，核对画面后点击选点。')}catch(e){message(e.message,true)}}
 init();
})();
