const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.join(__dirname,'..');
const transpile = file => ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const code = transpile('src/popup/popup.ts');
const contracts = {exports:{}};
vm.runInNewContext(transpile('src/shared/contracts.ts'),{exports:contracts.exports});
const events = contracts.exports.EVENTS;
const tick = () => new Promise(resolve=>setImmediate(resolve));
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const quick = (target='CAxTON',generation=2,captureGeneration=1) => ({phase:'success',generation,captureGeneration,requestId:`quick-${generation}`,target,
  result:{kind:'word',word:target,lemma:target.toLowerCase(),phonetic:'IPA',partOfSpeech:'n.',meaning:'BASE'}});
const editorView = (meaning='BASE',hasOverride=false) => ({sessionId:1,target:'CAxTON',hasOverride,fields:{lemma:'caxton',phonetic:'IPA',partOfSpeech:'n.',meaning}});

async function harness() {
  const elements=new Map(),listeners=new Map(),calls=[],responses=new Map();
  function element(id,hidden=false) {
    const e={hidden,disabled:false,textContent:'',value:'',className:'',handlers:new Map(),
      addEventListener(name,fn){this.handlers.set(name,fn);},focus(){this.focused=true;}};
    elements.set(id,e);return e;
  }
  const app=element('app');
  Object.defineProperty(app,'innerHTML',{set(html){for(const tag of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) element(tag[1],/\bhidden\b/.test(tag[0]));}});
  vm.runInNewContext(code,{
    exports:{},document:{querySelector:selector=>elements.get(selector.slice(1))},
    require(name) {
      if(name.endsWith('.css')) return {};
      if(name.includes('shared/contracts')) return contracts.exports;
      if(name.endsWith('/core')) return {invoke:async(name,args)=>{calls.push({name,args});return responses.has(name)?responses.get(name)(args):undefined;}};
      if(name.endsWith('/event')) return {listen:async(name,fn)=>listeners.set(name,fn)};
      if(name.endsWith('/window')) return {getCurrentWindow:()=>({hide:async()=>calls.push({name:'HIDE'})})};
      throw Error(name);
    },
  });
  await tick();
  const emit=async(name,payload)=>{assert.ok(listeners.has(name),name);listeners.get(name)({payload});await tick();};
  const click=async(id)=>{const e=elements.get(id);if(!e.disabled)e.handlers.get('click')?.({preventDefault(){}});await tick();};
  const submit=async()=>{elements.get('override-editor').handlers.get('submit')({preventDefault(){}});await tick();};
  return {el:id=>elements.get(id),calls,responses,emit,click,submit};
}

test('lightweight edit opens in place; original surface and optional fields; cancel writes nothing',async()=>{
  const h=await harness();h.responses.set('get_current_override',()=>editorView());
  await h.emit(events.popupTranslationState,quick());
  assert.equal(h.el('source-text').textContent,'CAxTON');assert.equal(h.el('word-display').textContent,'CAxTON');
  await h.click('edit-override');assert.equal(h.el('override-editor').hidden,false);assert.equal(h.el('quick-fields').hidden,true);
  assert.equal(h.el('edit-target').textContent,'CAxTON');assert.equal(h.el('restore-override').hidden,true);
  h.el('edit-meaning').value='UNSAVED';await h.click('cancel-override');
  assert.equal(h.el('override-editor').hidden,true);assert.equal(h.el('edit-meaning').value,'');
  assert.equal(h.calls.filter(c=>/save_current_override|remove_current_override/.test(c.name)).length,0);
});

test('Detail reference is initial prefill only; late Detail never changes draft or saves',async()=>{
  const h=await harness();h.responses.set('get_current_override',()=>editorView('DETAIL_REFERENCE'));
  await h.emit(events.popupTranslationState,quick());await h.click('edit-override');
  assert.equal(h.el('edit-meaning').value,'DETAIL_REFERENCE');h.el('edit-meaning').value='MY DRAFT';
  const d={generation:2,captureGeneration:1,quickRequestId:'quick-2',detailRequestId:'d1'};
  await h.emit(events.popupDetailState,{...d,phase:'loading'});
  await h.emit(events.popupDetailState,{...d,phase:'success',result:{meaningInSentence:'LATE_DETAIL'}});
  assert.equal(h.el('edit-meaning').value,'MY DRAFT');assert.equal(h.el('override-editor').hidden,false);
  assert.equal(h.el('detail-meaning').textContent,'LATE_DETAIL');
  assert.equal(h.calls.filter(c=>c.name==='save_current_override').length,0);
});

test('save patches Quick, keeps Detail and sends no translation/position request',async()=>{
  const h=await harness();h.responses.set('get_current_override',()=>editorView('OVERRIDE',true));
  h.responses.set('save_current_override',args=>({...quick().result,...args.fields}));
  await h.emit(events.popupTranslationState,quick());
  const d={generation:2,captureGeneration:1,quickRequestId:'quick-2',detailRequestId:'d'};
  await h.emit(events.popupDetailState,{...d,phase:'loading'});
  await h.emit(events.popupDetailState,{...d,phase:'success',result:{meaningInSentence:'CONTEXT',comparison:{word:'other',difference:'DIFFERENCE'}}});
  await h.click('edit-override');assert.equal(h.el('restore-override').hidden,false);
  h.el('edit-phonetic').value='';h.el('edit-pos').value='n./v.';h.el('edit-meaning').value=' MANUAL ';
  await h.submit();assert.equal(h.el('word-meaning').textContent,'MANUAL');assert.equal(h.el('word-phonetic').textContent,'-');
  assert.equal(h.el('override-editor').hidden,true);assert.equal(h.el('live-detail-result').hidden,false);
  assert.equal(h.el('detail-meaning').textContent,'CONTEXT');assert.equal(h.el('live-detail-request').hidden,true);
  const save=h.calls.find(c=>c.name==='save_current_override');assert.equal(save.args.sessionId,1);assert.equal(save.args.quickRequestId,'quick-2');
  assert.equal(save.args.fields.meaning,'MANUAL');assert.equal(save.args.fields.partOfSpeech,'n./v.');
  assert.deepEqual(h.calls.map(c=>c.name),['set_popup_listener_ready','set_popup_listener_ready','get_current_override','save_current_override']);
});

test('invalid meaning does not invoke; rejected save keeps editable draft and can retry',async()=>{
  const h=await harness();h.responses.set('get_current_override',()=>editorView());
  h.responses.set('save_current_override',()=>Promise.reject('个人词典保存失败'));
  await h.emit(events.popupTranslationState,quick());await h.click('edit-override');
  for(const value of [' ','x'.repeat(301)]) {h.el('edit-meaning').value=value;await h.submit();}
  assert.equal(h.calls.filter(c=>c.name==='save_current_override').length,0);
  h.el('edit-meaning').value='KEEP';await h.submit();
  assert.equal(h.el('override-editor').hidden,false);assert.equal(h.el('edit-meaning').value,'KEEP');assert.equal(h.el('save-override').disabled,false);
  assert.equal(h.el('word-meaning').textContent,'BASE');assert.match(h.el('override-notice').textContent,/保存失败/);
});

test('new capture invalidates draft before B Quick; delayed old save cannot patch B',async()=>{
  const h=await harness();const pending=deferred();h.responses.set('get_current_override',()=>editorView());h.responses.set('save_current_override',()=>pending.promise);
  await h.emit(events.popupTranslationState,quick());await h.click('edit-override');h.el('edit-meaning').value='A';await h.submit();
  await h.emit(events.popupSelectionInvalidated,2);assert.equal(h.el('override-editor').hidden,true);assert.equal(h.el('edit-meaning').value,'');
  await h.emit(events.popupTranslationState,quick('computation',4,2));
  pending.resolve({...quick().result,meaning:'A'});await tick();
  assert.equal(h.el('source-text').textContent,'computation');assert.equal(h.el('word-meaning').textContent,'BASE');
  // An out-of-order invalidation for B must not wipe B's new draft.
  h.responses.set('get_current_override',()=>({...editorView(),target:'computation'}));await h.click('edit-override');
  await h.emit(events.popupSelectionInvalidated,2);assert.equal(h.el('override-editor').hidden,false);
});

test('pause/resume discards draft and rejects late open and stale Quick',async()=>{
  const h=await harness();const pending=deferred();h.responses.set('get_current_override',()=>pending.promise);
  await h.emit(events.popupTranslationState,quick());await h.click('edit-override');
  await h.emit(events.autoTranslateChanged,{autoTranslateEnabled:false});await h.emit(events.autoTranslateChanged,{autoTranslateEnabled:true});
  pending.resolve(editorView());await tick();assert.equal(h.el('override-editor').hidden,true);
  await h.emit(events.popupTranslationState,quick());assert.equal(h.el('edit-override').disabled,true);
  await h.emit(events.popupTranslationState,quick('next',4,2));assert.equal(h.el('edit-override').disabled,false);
});

test('restore updates locally; Base MISS asks for reselect without network and preserves Detail',async()=>{
  for(const hasBase of [true,false]) {
    const h=await harness();h.responses.set('get_current_override',()=>editorView('OLD',true));
    h.responses.set('remove_current_override',()=>hasBase?{...quick().result,meaning:'RESTORED'}:null);
    await h.emit(events.popupTranslationState,quick());
    const d={generation:2,captureGeneration:1,quickRequestId:'quick-2',detailRequestId:'restore-detail'};
    await h.emit(events.popupDetailState,{...d,phase:'loading'});
    await h.click('edit-override');await h.click('restore-override');
    assert.equal(h.el('override-editor').hidden,true);
    if(hasBase) assert.equal(h.el('word-meaning').textContent,'RESTORED');
    else {assert.equal(h.el('quick-fields').hidden,true);assert.equal(h.el('save-vocabulary').disabled,true);assert.match(h.el('override-notice').textContent,/重新划词/);}
    await h.emit(events.popupDetailState,{...d,phase:'success',result:{meaningInSentence:'INDEPENDENT_DETAIL'}});
    assert.equal(h.el('live-detail-result').hidden,false);assert.equal(h.el('detail-meaning').textContent,'INDEPENDENT_DETAIL');
    assert.equal(h.calls.filter(c=>c.name.includes('translation')||c.name.includes('detail')).length,0);
  }
});

test('switch to loading, error or mock discards edits; text is never injected as HTML',async()=>{
  for(const type of ['loading','error','mock']) {
    const h=await harness();h.responses.set('get_current_override',()=>editorView('<img onerror=bad>'));
    await h.emit(events.popupTranslationState,quick());await h.click('edit-override');
    assert.equal(h.el('edit-meaning').value,'<img onerror=bad>');
    if(type==='mock') await h.emit(events.translationStateChanged,{mock:true,generation:4,view:'word',phase:'success',title:'mock',body:'mock'});
    else await h.emit(events.popupTranslationState,{...quick('new',4,2),phase:type,requestType:'wordAnalysis',errorKind:'terminal',message:'error'});
    assert.equal(h.el('override-editor').hidden,true);assert.equal(h.el('edit-meaning').value,'');
  }
});
