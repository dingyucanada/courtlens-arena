import {validateProject} from './domain.mjs';

const copy = value => structuredClone(value);
const timestamp = () => new Date().toISOString();
const conflict = () => Object.assign(new Error('This project changed in another tab. Reload the latest revision before saving.'),{code:'CONFLICT'});
const validationError = issues => Object.assign(new Error(issues.filter(item => item.severity === 'error').slice(0,4).map(item => item.message).join(' ')),{code:'VALIDATION',issues});
function assertProject(project) {
  const issues = validateProject(project);
  if (issues.some(item => item.severity === 'error')) throw validationError(issues);
}
function content(project) {
  const {revision,createdAt,updatedAt,status,activity,...rest} = project;
  return rest;
}
function same(a,b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((key,index) => key === kb[index] && same(a[key],b[key]));
}
function prepare(project,current) {
  const next = copy(project);
  if (current) {
    const bindingChanged = !same(next.video,current.video);
    const prior = new Map(current.plays.map(play => [play.id,play]));
    next.plays = next.plays.map(play => {
      const before = prior.get(play.id);
      const {reviewed,...rest} = play;
      const {reviewed:wasReviewed,...oldRest} = before || {};
      return bindingChanged || !before || !same(rest,oldRest) ? {...play,reviewed:false} : play;
    });
    if (!same(content(next),content(current))) next.status = 'draft';
    next.createdAt = current.createdAt;
  }
  next.revision = (current?.revision || 0) + 1;
  next.updatedAt = timestamp();
  assertProject(next);
  return next;
}

/** Durable browser storage. No in-memory fallback: unavailable storage is an explicit error. */
export class StudioStore {
  constructor(options = {}) {
    if (typeof options === 'string') options = {name:options};
    this.name = options.name || 'courtlens-studio-v1';
    this.indexedDB = options.indexedDB || globalThis.indexedDB;
    this.db = null;
    this.opening = null;
  }
  async open() {
    if (this.db) return this;
    if (this.opening) return this.opening;
    if (!this.indexedDB) throw Object.assign(new Error('IndexedDB is unavailable. Enable browser site storage to use Studio.'),{code:'STORAGE_UNAVAILABLE'});
    this.opening = new Promise((resolve,reject) => {
      let settled = false;
      const request = this.indexedDB.open(this.name,1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects',{keyPath:'id'});
        if (!db.objectStoreNames.contains('history')) {
          const history = db.createObjectStore('history',{keyPath:['projectId','revision']});
          history.createIndex('projectId','projectId',{unique:false});
        }
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media',{keyPath:'id'});
      };
      request.onsuccess = () => {
        if (settled) {request.result.close();return;}
        settled = true; this.db = request.result;
        this.db.onversionchange = () => {this.db?.close();this.db=null;};
        this.db.onclose = () => {this.db=null;};
        resolve(this);
      };
      request.onerror = () => {if (!settled) {settled=true;reject(request.error || new Error('Could not open Studio storage.'));}};
      request.onblocked = () => {if (!settled) {settled=true;reject(Object.assign(new Error('Storage upgrade is blocked by another Studio tab. Close that tab and retry.'),{code:'STORAGE_BLOCKED'}));}};
    }).finally(() => {this.opening=null;});
    return this.opening;
  }
  close() {this.db?.close();this.db=null;}
  async _read(storeName,key,all = false,indexName = null) {
    await this.open();
    return new Promise((resolve,reject) => {
      let value;
      const tx = this.db.transaction(storeName,'readonly');
      const store = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
      const request = all ? (key === undefined ? store.getAll() : store.getAll(key)) : store.get(key);
      request.onsuccess = () => {value=request.result;};
      tx.oncomplete = () => resolve(value === undefined ? null : copy(value));
      tx.onabort = () => reject(tx.error || request.error || new Error('Storage read aborted.'));
      tx.onerror = () => {};
    });
  }
  async list() {
    const projects = await this._read('projects',undefined,true);
    return projects.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.revision - a.revision || a.id.localeCompare(b.id));
  }
  async get(projectId) {return this._read('projects',projectId);}
  async history(projectId) {
    const entries = await this._read('history',projectId,true,'projectId');
    return entries.sort((a,b) => b.revision - a.revision).map(({revision,at,name,project}) => ({revision,at,name,project}));
  }
  async save(project,expectedRevision) {
    // Validate the input as plain data before structuredClone can invoke any accessors.
    assertProject(project);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('expectedRevision must be a nonnegative integer.');
    const input = copy(project);
    await this.open();
    return this._writeRevision(input.id,expectedRevision,() => input);
  }
  _writeRevision(projectId,expectedRevision,transform,restoreRevision = null) {
    return new Promise((resolve,reject) => {
      let saved, failure;
      const tx = this.db.transaction(['projects','history','media'],'readwrite');
      const projects = tx.objectStore('projects'), history = tx.objectStore('history');
      const abort = error => {failure=error;try {tx.abort();} catch {} };
      const currentRequest = projects.get(projectId);
      currentRequest.onsuccess = () => {
        const current = currentRequest.result;
        if ((current?.revision || 0) !== expectedRevision || (!current && expectedRevision !== 0)) {abort(conflict());return;}
        const write = candidate => {
          try {
            if (candidate.id !== projectId) throw new Error('Project identity cannot change while saving.');
            saved = prepare(candidate,current);
            const commit = () => {
              projects.put(saved);
              history.add({projectId,revision:saved.revision,at:saved.updatedAt,name:saved.name,project:copy(saved)});
            };
            if (saved.status === 'approved' && saved.video?.url !== 'media/demo.mp4') {
              const mediaRequest = tx.objectStore('media').get(saved.video.id);
              mediaRequest.onsuccess = () => {
                if (!(mediaRequest.result?.blob instanceof Blob)) {abort(Object.assign(new Error('The bound local video is missing. Reattach it before approval.'),{code:'MEDIA_MISSING'}));return;}
                if (mediaRequest.result.blob.size !== saved.video.size) {abort(Object.assign(new Error('The bound video size differs from the saved metadata. Reattach it before approval.'),{code:'MEDIA_MISMATCH'}));return;}
                commit();
              };
            } else commit();
          } catch (error) {abort(error);}
        };
        if (restoreRevision !== null) {
          if (!current) {abort(new Error('Project no longer exists.'));return;}
          const revisionRequest = history.get([projectId,restoreRevision]);
          revisionRequest.onsuccess = () => {
            if (!revisionRequest.result) {abort(new Error('The requested history revision was not found.'));return;}
            const restored = copy(revisionRequest.result.project);
            // Historical evidence remains available; restoring requires fresh approval.
            restored.status = 'draft';
            restored.plays = restored.plays.map(play => ({...play,reviewed:false}));
            restored.activity = [...(current.activity || []),{at:timestamp(),type:'restore',message:`Restored revision ${restoreRevision}.`}].slice(-10000);
            write(restored);
          };
        } else {
          try {write(transform(current));} catch (error) {abort(error);}
        }
      };
      tx.oncomplete = () => resolve(copy(saved));
      tx.onabort = () => reject(failure || tx.error || new Error('Save transaction aborted; no changes were committed.'));
      tx.onerror = () => {};
    });
  }
  async restore(projectId,revision,expectedRevision) {
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Restore requires positive revision numbers.');
    await this.open();
    return this._writeRevision(projectId,expectedRevision,null,revision);
  }
  async archive(projectId,expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Archive requires the current positive revision.');
    await this.open();
    return this._writeRevision(projectId,expectedRevision,current => {
      if (!current) throw new Error('Project no longer exists.');
      return {...current,archived:true,status:'draft'};
    });
  }
  async putMedia(mediaId,blob) {
    if (typeof mediaId !== 'string' || !mediaId.trim() || mediaId.length > 200 || !(blob instanceof Blob) || blob.size === 0) throw new Error('A nonempty media ID and nonempty video Blob are required.');
    await this.open();
    return new Promise((resolve,reject) => {
      const tx = this.db.transaction('media','readwrite');
      // Media IDs are immutable: replacing bytes must use a new ID and invalidate review.
      tx.objectStore('media').add({id:mediaId,blob});
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Video storage failed; no media was committed.'));
      tx.onerror = () => {};
    });
  }
  async getMedia(mediaId) {return (await this._read('media',mediaId))?.blob || null;}
  async storageInfo() {
    const storage = globalThis.navigator?.storage;
    const estimate = storage?.estimate ? await storage.estimate() : {};
    const persisted = storage?.persisted ? await storage.persisted() : false;
    return {usage:estimate.usage ?? null,quota:estimate.quota ?? null,persisted};
  }
  async requestPersistence() {
    return globalThis.navigator?.storage?.persist ? Boolean(await globalThis.navigator.storage.persist()) : false;
  }
}
