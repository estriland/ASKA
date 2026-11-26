import {spawn} from 'node:child_process';
import readline from 'node:readline';

/** Serial transport only. A timeout destroys the process; it never retries a request. */
export class NativeChannel {
  #process; #pending=null; #closed=false; #trace; #done;
  constructor(binary, trace=()=>{}) {
    this.#trace=trace;
    this.#process=spawn(binary,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.#done=new Promise(resolve=>this.#process.once('close',resolve));
    this.#process.stderr.on('data',()=>{}); // No environment, credentials or inherited diagnostics are logged.
    readline.createInterface({input:this.#process.stdout}).on('line',line=>{
      const pending=this.#pending;
      if(!pending)return this.#fail(Object.assign(new Error('UNSOLICITED_NATIVE_REPLY'),{code:'UNSOLICITED_NATIVE_REPLY'}));
      this.#pending=null;clearTimeout(pending.timer);
      try {
        const reply=JSON.parse(line);this.#trace({request:pending.request,raw_response:line,response:reply});
        if(reply.ok!==true)throw Object.assign(new Error(reply.error?.message??'Native error'),reply.error);
        pending.resolve(reply.result);
      } catch(error) { pending.reject(error); }
    });
    this.#process.on('error',error=>this.#fail(error));
    this.#process.on('exit',()=>this.#fail(Object.assign(new Error('NATIVE_EXIT'),{code:'NATIVE_EXIT'})));
    this.#process.stdin.on('error',error=>this.#fail(error));
  }
  #fail(error){
    this.#closed=true;
    if(this.#pending){const p=this.#pending;this.#pending=null;clearTimeout(p.timer);p.reject(error);}
    this.#process.kill();
  }
  call(request) {
    if(this.#closed||this.#pending)return Promise.reject(Object.assign(new Error('NATIVE_UNAVAILABLE_OR_BUSY'),{code:'NATIVE_UNAVAILABLE_OR_BUSY'}));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.#fail(Object.assign(new Error('NATIVE_TIMEOUT'),{code:'NATIVE_TIMEOUT'})),30000);
      this.#pending={resolve,reject,timer,request:structuredClone(request)};
      this.#process.stdin.write(JSON.stringify(request)+'\n');
    });
  }
  async close(){
    this.#fail(Object.assign(new Error('NATIVE_CLOSED'),{code:'NATIVE_CLOSED'}));
    await this.#done;
  }
}
