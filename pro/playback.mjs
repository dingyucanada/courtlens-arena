/** Source video clocks. Requested seek time is never called a decoded frame. */
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function displayTime(video,decodedTime){return finite(decodedTime)?decodedTime:video.currentTime;}

/** Seek and wait for a submitted source frame; stale initial frames are ignored.
 * Browser fallback returns an explicitly approximate player clock.
 */
export function seekDecodedFrame(video,target,{timeoutMs=10000,signal,notBefore=0,before=Infinity}={}){
  if(!video||!finite(target)||target<0)return Promise.reject(new Error('视频定位时间无效。'));
  if(!finite(notBefore)||notBefore<0||!(finite(before)||before===Infinity)||before<=notBefore||target<notBefore||target>=before)return Promise.reject(new Error('定位必须处于指定片段内，并早于结束或揭晓时刻。'));
  return new Promise((resolve,reject)=>{
    let handle=null,timer=null,seeked=false,frame=null,done=false,phase='idle',generation=0;
    const decoded=typeof video.requestVideoFrameCallback==='function'&&typeof video.cancelVideoFrameCallback==='function';
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener('loadedmetadata',start);video.removeEventListener('seeked',onSeek);video.removeEventListener('error',onError);signal?.removeEventListener('abort',onAbort);if(handle!=null)video.cancelVideoFrameCallback(handle);};
    const finish=(cause,value)=>{if(done)return;done=true;video.pause();cleanup();cause?reject(cause):resolve(value);};
    const inspect=()=>{if(!seeked)return;if(decoded&&frame==null)return;const time=decoded?frame:video.currentTime;if(!finite(time))return finish(new Error('视频未返回有效帧时间。'));if(time<notBefore||time>=before)return finish(new Error('实际画面已越过允许时段，不能用于出手前决策或片段预览。请选更早的时刻或延长片段。'));finish(null,{time,clock:decoded?'decoded-media-time':'player-time-approximate',frameAccurate:decoded});};
    const request=()=>{const epoch=generation;handle=video.requestVideoFrameCallback((_,metadata)=>{if(done||epoch!==generation)return;handle=null;const t=metadata?.mediaTime;if(seeked&&video.seeking!==true&&finite(t)&&Math.abs(t-target)<=1){frame=t;inspect();}if(!done)request();});};
    const targetSeek=()=>{phase='target';seeked=false;frame=null;video.currentTime=target;};
    const onSeek=()=>{
      if(phase==='prime'){targetSeek();return;}
      if(phase!=='target')return;
      // Only a callback registered after the final seek completes may certify the frame.
      // Some browsers submit the seek frame before seeked. Briefly play after seeked
      // to obtain a fresh submission, then pause at that actual frame (not the requested time).
      seeked=true;frame=null;generation++;if(handle!=null)video.cancelVideoFrameCallback(handle);handle=null;
      if(decoded){request();try{Promise.resolve(video.play()).catch(()=>finish(new Error('冻结画面无法提交新帧，请检查视频播放权限。')));}catch{finish(new Error('冻结画面无法播放。'));}}else inspect();
    };
    const onError=()=>finish(new Error('冻结画面无法解码。'));
    const onAbort=()=>finish(Object.assign(new Error('视频定位已取消。'),{name:'AbortError'}));
    function start(){
      if(done)return;video.pause();
      if(!finite(video.duration)||target>video.duration)return finish(new Error('视频定位超出原片时长。'));
      video.addEventListener('seeked',onSeek);video.addEventListener('error',onError);
      // A no-op seek may not submit a frame. Complete the prime seek before returning.
      if(Math.abs(video.currentTime-target)<.001){const prime=target+.08<video.duration?target+.08:Math.max(0,target-.08);if(prime===target)return finish(new Error('视频内没有可定位的帧。'));phase='prime';video.currentTime=prime;}else targetSeek();
    }
    if(signal?.aborted)return onAbort();signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>finish(new Error('视频定位或帧解码超时，请重试。')),timeoutMs);
    if(video.readyState>=1)start();else video.addEventListener('loadedmetadata',start,{once:true});
  });
}

/** Each decoded callback belongs to this video element; caller disposes on render. */
export function observeDecodedFrames(video,onFrame){
  if(typeof video.requestVideoFrameCallback!=='function')return ()=>{};
  let closed=false,handle;
  const request=()=>{handle=video.requestVideoFrameCallback((_,metadata)=>{if(closed)return;if(finite(metadata?.mediaTime))onFrame(metadata.mediaTime);if(!closed)request();});};request();
  return ()=>{closed=true;if(handle!=null)video.cancelVideoFrameCallback?.(handle);};
}
export function previewOutputTime(plan,index,sourceTime){
  const clip=plan?.clips?.[index];if(!clip||!finite(sourceTime))throw new Error('片单预览时间无效。');
  return clip.outputStart+Math.max(0,Math.min(clip.end-clip.start,sourceTime-clip.start));
}
