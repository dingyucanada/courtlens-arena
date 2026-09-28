import {validateProject} from './model.mjs';
export class ArenaStore {
  constructor(name='courtlens-arena-v1'){this.name=name;this.db=null;}
  async open(){
    if(this.db)return this;
    if(!globalThis.indexedDB)throw new Error('浏览器未允许本机数据存储。');
    await new Promise((resolve,reject)=>{const req=indexedDB.open(this.name,1);
      req.onupgradeneeded=()=>{for(const [n,key] of [['projects','id'],['media','id'],['history',['id','revision']]])if(!req.result.objectStoreNames.contains(n))req.result.createObjectStore(n,{keyPath:key});};
      req.onsuccess=()=>{this.db=req.result;this.db.onversionchange=()=>{this.db.close();this.db=null;};resolve();};
      req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('另一个页面正在使用存储，请关闭旧页面再重试。'));
    });return this;
  }
  async read(store,key,all=false){await this.open();return new Promise((resolve,reject)=>{const tx=this.db.transaction(store,'readonly');let result;const req=all?tx.objectStore(store).getAll():tx.objectStore(store).get(key);req.onsuccess=()=>result=req.result;tx.oncomplete=()=>resolve(result??null);tx.onabort=()=>reject(tx.error||req.error);});}
  async list(){return (await this.read('projects',null,true)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  async get(id){return this.read('projects',id);}
  async media(id){return (await this.read('media',id))?.blob??null;}
  async putMedia(id,blob){if(!(blob instanceof Blob)||!blob.size)throw new Error('视频为空。');await this.open();await new Promise((resolve,reject)=>{const tx=this.db.transaction('media','readwrite');tx.objectStore('media').add({id,blob});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('视频存储失败。'));});}
  async save(project,expected=project.revision||0,media=null){
    validateProject(project);const value=structuredClone(project);await this.open();
    if(media&&(!(media.blob instanceof Blob)||!media.blob.size||media.id!==value.video?.id))throw new Error('视频绑定数据不完整。');
    return new Promise((resolve,reject)=>{
      const tx=this.db.transaction(media?['projects','history','media']:['projects','history'],'readwrite');let saved,error;const req=tx.objectStore('projects').get(value.id);
      req.onsuccess=()=>{const current=req.result;if((current?.revision||0)!==expected){error=Object.assign(new Error('另一个页面已修改这个项目。请重新载入，避免覆盖。'),{code:'CONFLICT'});tx.abort();return;}
        saved={...value,revision:expected+1,updatedAt:new Date().toISOString()};tx.objectStore('projects').put(saved);tx.objectStore('history').add({id:saved.id,revision:saved.revision,project:saved});if(media)tx.objectStore('media').add(media);};
      tx.oncomplete=()=>resolve(saved);tx.onabort=()=>reject(error||tx.error||new Error('保存失败，原版本仍然保留。'));
    });
  }
  async history(id){await this.open();return new Promise((resolve,reject)=>{const tx=this.db.transaction('history','readonly');let rows=[];const req=tx.objectStore('history').getAll(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]));req.onsuccess=()=>rows=req.result;tx.oncomplete=()=>resolve(rows.sort((a,b)=>b.revision-a.revision));tx.onabort=()=>reject(tx.error||req.error);});}
  async restore(project,revision){const entry=await this.read('history',[project.id,revision]);if(!entry)throw new Error('历史版本不存在。');const value={...entry.project,revision:project.revision};value.plays=value.plays.map(p=>({...p,reviewed:false}));return this.save(value,project.revision);}
}
