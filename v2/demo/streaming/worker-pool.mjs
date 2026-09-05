/** No hidden work queue: the CPU scheduler decides priority/backpressure.
 * A slot is occupied until a result, abort acknowledgement, or termination. */
export class StreamWorkerPool {
  constructor(count, factory=()=>new Worker(new URL('./terrain.worker.mjs',import.meta.url),{type:'module'})) {
    if(!Number.isInteger(count)||count<1||count>2)throw new Error('INVALID_WORKER_COUNT');
    this.factory=factory;this.slots=Array.from({length:count},()=>({worker:null,task:null}));
    this.disposed=false;this.created=0;this.terminated=0;this.lateResults=0;
  }
  get available(){return this.disposed?0:this.slots.filter(s=>!s.task).length;}
  kill(slot){if(slot.worker){slot.worker.terminate();slot.worker=null;this.terminated++;}}
  run(ticket,job,signal) {
    const slot=this.slots.find(s=>!s.task);
    if(!slot||this.disposed||signal.aborted)return Promise.reject(Object.assign(new Error('ABORTED'),{attempts:0}));
    return new Promise((resolve,reject)=>{
      const task={ticket,resolve,reject,signal,abort:null,timer:null,abortTimer:null};slot.task=task;
      const settle=(error,result,kill=false)=>{
        if(slot.task!==task)return;
        clearTimeout(task.timer);clearTimeout(task.abortTimer);signal.removeEventListener('abort',task.abort);
        slot.task=null;if(kill)this.kill(slot);
        if(error)reject(error);else resolve(result);
      };
      task.settle=settle;
      task.abort=()=>{
        slot.worker?.postMessage({kind:'cancel',revision:ticket.revision});
        task.abortTimer=setTimeout(()=>settle(Object.assign(new Error('ABORTED'),{attempts:null}),null,true),750);
      };
      signal.addEventListener('abort',task.abort,{once:true});
      try{if(!slot.worker){slot.worker=this.factory();this.created++;}}catch{settle(Object.assign(new Error('STREAM_WORKER_ERROR'),{attempts:0}),null,true);return;}
      slot.worker.onmessage=({data})=>{
        if(slot.task!==task||data.ticket?.revision!==ticket.revision||data.ticket?.key!==ticket.key){this.lateResults++;return;}
        if(data.kind==='result') settle(null,data);
        else settle(Object.assign(new Error(data.code||'STREAM_WORKER_ERROR'),{attempts:data.attempts}));
      };
      slot.worker.onerror=()=>settle(Object.assign(new Error('STREAM_WORKER_ERROR'),{attempts:null}),null,true);
      slot.worker.onmessageerror=()=>settle(Object.assign(new Error('STREAM_WORKER_MESSAGE_ERROR'),{attempts:null}),null,true);
      task.timer=setTimeout(()=>settle(Object.assign(new Error('STREAM_WORKER_TIMEOUT'),{attempts:null}),null,true),60000);
      try{slot.worker.postMessage({kind:'build',ticket,job});}catch{settle(Object.assign(new Error('STREAM_WORKER_ERROR'),{attempts:null}),null,true);}
    });
  }
  dispose(){
    this.disposed=true;
    for(const slot of this.slots){slot.task?.settle(Object.assign(new Error('ABORTED'),{attempts:null}),null,true);this.kill(slot);}
  }
}
