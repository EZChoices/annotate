"use strict";

// Minimal IndexedDB queue for offline sync
const EAIDB = (function(){
  const DB_NAME = 'ea_stage2_db';
  const STORE = 'ea_stage2_queue';
  let dbp = null;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise((resolve, reject)=>{
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)){
          db.createObjectStore(STORE, { keyPath: '_id', autoIncrement: true });
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

  return { enqueue, peekBatch, removeBatch };
})();

