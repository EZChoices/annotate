"use strict";

// Minimal IndexedDB queue for offline sync
const EAIDB = (function(){
  const DB_NAME = 'ea_stage2_db';
  const STORE = 'ea_stage2_queue';
  const LINT_STORE = 'ea_stage2_lint';
  let dbp = null;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise((resolve, reject)=>{
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        if(ev.oldVersion < 1){
          if(!db.objectStoreNames.contains(STORE)){
            db.createObjectStore(STORE, { keyPath: '_id', autoIncrement: true });
          }
        }
        if(ev.oldVersion < 2){
          if(!db.objectStoreNames.contains(LINT_STORE)){
            db.createObjectStore(LINT_STORE, { keyPath: 'asset_id' });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function enqueue(payload){
    const db = await open();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add({ payload, ts: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function peekBatch(limit){
    const db = await open();
    return new Promise((resolve, reject)=>{
      const out = [];
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if(cur && out.length < limit){
          const val = cur.value; val._id = cur.key; out.push(val);
          cur.continue();
        } else {
          resolve(out.map(v=> v.payload ? ({...v.payload, _id: v._id}) : v));
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function removeBatch(ids){
    const db = await open();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      (ids||[]).forEach(id=> st.delete(id));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveLintReport(assetId, lint){
    if(!assetId) return false;
    const db = await open();
    return new Promise((resolve, reject)=>{
      try{
        const tx = db.transaction(LINT_STORE, 'readwrite');
        const store = tx.objectStore(LINT_STORE);
        const record = { asset_id: assetId, lint: lint || { errors: [], warnings: [] }, ts: Date.now() };
        store.put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      }catch(err){
        resolve(false);
      }
    });
  }

  async function getLintReport(assetId){
    if(!assetId) return null;
    const db = await open();
    return new Promise((resolve)=>{
      try{
        const tx = db.transaction(LINT_STORE, 'readonly');
        const store = tx.objectStore(LINT_STORE);
        const req = store.get(assetId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      }catch(err){
        resolve(null);
      }
    });
  }

  return { enqueue, peekBatch, removeBatch, saveLintReport, getLintReport };
})();

