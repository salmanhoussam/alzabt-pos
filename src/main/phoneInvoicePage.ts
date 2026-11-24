/**
 * DEC-35z16 (owner, PILOT): the phone page of an INVOICE_BATCH session — «تصوير فواتير المورّدين».
 *
 * One photo per supplier invoice: take or pick it, it is sent to the till, «استُلمت» is shown with the
 * running count, then «تصوير فاتورة أخرى» or «إنهاء والمتابعة على الكمبيوتر». An accidental photo can
 * be removed before finishing.
 *
 * Samsung Internet recovery: the gallery picks ONE photo at a time; reopen it for additional invoices.
 * The existing queue sends photos one at a time, in order, each with its own capture key; each line shows waiting / sending / not sent / refused, a
 * lost connection stops the run (the rest wait for «إعادة المحاولة»), a refusal (duplicate, too large) does
 * not stop the others, and the till's LIMIT refuses the rest. «استُلمت» only ever follows the till's ok. Nothing on this page creates a product or touches the ledger — the
 * till reviews each invoice on its own, through the existing Photo Invoice review, and only that
 * review's explicit confirmation writes anything.
 *
 * 🔴 SELF-CONTAINED AND OFFLINE like the product page: inline style and script only (the CSP allows
 * nothing else), no CDN, no font service. Thumbnails are object URLs of the phone's OWN files (`blob:`,
 * allowed on this page only); the till never sends an image back.
 *
 * 🔴 RETRY WITHOUT DUPLICATES. Each photo gets a random capture key once, on the phone; a failed send
 * is retried with the SAME key, so a send whose answer was lost is recognised by the till rather than
 * stored twice. (`crypto.getRandomValues` is available on a plain-HTTP page; `crypto.subtle` is not
 * and is not used.)
 *
 * 🔴 THE PAGE IS RENDERED WITH THE BATCH SO FAR (count + sizes), so reloading it on the phone shows
 * the truth rather than an empty list.
 */
export interface PhoneInvoicePageView {
  readonly items: ReadonlyArray<{ readonly id: string; readonly bytes: number }>;
  readonly maxPerBatch: number;
}

export function renderPhoneInvoicePage(view: PhoneInvoicePageView): string {
  // Only server-made values (32-hex ids and integers) are embedded; nothing typed by anyone.
  const initial = JSON.stringify(view.items.map((i) => ({ id: i.id, bytes: i.bytes })));
  return `<!doctype html>
<html lang="ar" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تصوير فواتير المورّدين — عالضبط</title>
<style>
  /* The page hides and shows elements with the hidden attribute; .big sets display:block, which would beat it. */
  [hidden]{display:none!important}
  body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;line-height:1.5;background:#fafafa;color:#1b1b1b}
  h1{font-size:20px;margin:0 0 4px}
  .muted{color:#555;font-size:14px;margin:0 0 12px}
  .count{font-size:18px;font-weight:700;margin:12px 0}
  .big{display:block;width:100%;box-sizing:border-box;padding:16px;margin:8px 0;font-size:18px;border-radius:10px;border:1px solid #0b5;background:#fff;text-align:center}
  .primary{background:#0a7d3a;color:#fff;border-color:#0a7d3a;font-weight:700}
  .finish{background:#174ea6;color:#fff;border-color:#174ea6;font-weight:700}
  .big[disabled]{opacity:.45}
  .status{min-height:24px;margin:8px 0;font-size:16px}
  .ok{color:#0a6b30}.err{color:#b00020}
  ul{list-style:none;padding:0;margin:8px 0}
  li{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px;margin:6px 0}
  li img{width:56px;height:56px;object-fit:contain;border:1px solid #ccc;border-radius:6px;background:#fff}
  li .grow{flex:1}
  li button{padding:8px 12px;border-radius:8px;border:1px solid #b00020;background:#fff;color:#b00020}
  input[type=file]{display:none}
  .done{font-size:18px;font-weight:700;color:#0a6b30}
  .note{font-size:13px;color:#666;margin-top:16px}
  .progress{font-size:15px;font-weight:700;margin:4px 0;min-height:0}
  .upload-diagnostic{border:2px solid #704b00;background:#fff8db;border-radius:8px;padding:10px;margin:12px 0}
  .upload-diagnostic pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;font:14px/1.5 system-ui,sans-serif}
  li[data-state=fail],li[data-state=refused]{border-color:#b00020}
</style>
<body>
<h1>تصوير فواتير المورّدين</h1>
<p class="muted">اختر صورة واحدة لكل فاتورة، ثم افتح المعرض مجدداً لإضافة فواتير أخرى. لا يُضاف أي صنف قبل مراجعتك وتأكيدك على الكمبيوتر.</p>
<section class="upload-diagnostic" id="diagPanel" hidden data-testid="inv-diagnostic">
  <strong>تشخيص تجريبي للرفع</strong>
  <p>سجل المراحل فقط، دون أسماء الملفات أو الصور أو رمز الجلسة.</p>
  <pre id="diagHistory" data-testid="inv-diagnostic-history"></pre>
</section>
<div id="live">
  <p class="count" data-testid="inv-count">الفواتير المستلمة: <b id="n">0</b></p>
  <label class="big primary" for="cam" id="camLabel" data-testid="inv-camera-label">📷 تصوير فاتورة</label>
  <input id="cam" type="file" accept="image/*" capture="environment" data-testid="inv-camera">
  <label class="big" for="gal" id="galLabel" data-testid="inv-gallery-label">🖼️ اختيار صورة واحدة من المعرض — افتحه مجدداً لكل فاتورة</label>
  <input id="gal" type="file" accept="image/*" data-testid="inv-gallery">
  <p class="progress" id="progress" data-testid="inv-progress"></p>
  <p class="status" id="status" role="status" data-testid="inv-status"></p>
  <p class="status err" id="limitNote" hidden data-testid="inv-limit-note"></p>
  <button class="big" id="retry" hidden data-testid="inv-retry">إعادة المحاولة</button>
  <button class="big" id="another" hidden data-testid="inv-another">تصوير فاتورة أخرى</button>
  <ul id="queue" data-testid="inv-queue"></ul>
  <ul id="list" data-testid="inv-list"></ul>
  <button class="big finish" id="finish" disabled data-testid="inv-finish">إنهاء والمتابعة على الكمبيوتر</button>
  <p class="note">الإرسال عبر شبكة المحل المحلية فقط. استعملها على شبكة Wi-Fi المحل الخاصة.</p>
</div>
<p class="done" id="done" hidden data-testid="inv-done"></p>
<script>
(function(){
  var MAX=${view.maxPerBatch};
  var items=${initial};
  var thumbs={};
  // Gallery selections are single-photo; the existing queue still sends photos ONE AT A TIME,
  // in order, each with its own capture key made once — a retry re-sends the SAME key, so a send whose
  // answer was lost is recognised by the till, never stored twice. A photo counts as received only when
  // the till answered ok (after it wrote the file to disk); nothing is ever shown as received before.
  var queue=[]; // {file,key,state:"wait"|"send"|"fail"|"refused"|"ok",msg,thumb}
  var busy=false;
  var over=false;
  var base=location.pathname.replace(/\\/$/,"");
  var $=function(id){return document.getElementById(id)};
  // Temporary pilot diagnostics: fixed labels and bounded numbers only; no URL, key,
  // error, filename, photo, response body or other merchant data is recorded.
  var diag=(function(){
    var enabled=location.hash==="#upload-diagnostics",history=[],pending=0,sequence=0,away=false,timer=false;
    var labels={init:"1. تهيئة الصفحة اكتملت",gallery:"2. ضُغط زر المعرض",request:"3. طُلب فتح منتقي الملفات (الفتح غير مؤكد)",
      hidden:"4. الصفحة فقدت الظهور",visible:"4. الصفحة عادت للظهور",blur:"4. الصفحة فقدت التركيز",focus:"4. الصفحة استعادت التركيز",
      change:"5. وصل حدث تغيير الملف",files:"6. عدد الملفات لدى المعالج",queue:"7. بدأت معالجة قائمة الإرسال",
      send:"8. بدأت محاولة طلب الرفع",response:"9. وصل رد HTTP — الحالة",ok:"10. أكد الخادم الاستلام",
      rejected:"10. لم يؤكد الخادم الاستلام",network:"10. فشل طلب الرفع أو لم يصل رد",
      nochange:"4. عاد التركيز أو الظهور ولم يُرصد تغيير للملف بعد؛ السبب غير معروف",
      cancel:"4. أبلغ المتصفح عن إلغاء المنتقي؛ لم يُرصد تغيير للملف"};
    function valid(x){return x&&typeof x==="object"&&typeof x.c==="string"&&Object.prototype.hasOwnProperty.call(labels,x.c)&&
      ((x.c==="files"&&Number.isInteger(x.v)&&x.v>=0&&x.v<=9999)||
       (x.c==="response"&&Number.isInteger(x.v)&&x.v>=100&&x.v<=599)||
       (x.c!=="files"&&x.c!=="response"&&x.v===undefined))}
    function show(){try{$("diagHistory").textContent=history.map(function(x){return labels[x.c]+(x.v===undefined?"":": "+x.v)}).join("\\n")}catch(e){}}
    function record(c,v){
      if(!enabled)return;
      try{
        var x=v===undefined?{c:c}:{c:c,v:v};if(!valid(x))return;
        history.push(x);if(history.length>30)history=history.slice(-30);
        show();try{window.sessionStorage.setItem("inv-diag-v1",JSON.stringify(history))}catch(e){}
      }catch(e){}
    }
    function returned(c){
      record(c);
      if(!pending||!away||timer)return;
      timer=true;var attempt=pending;
      window.setTimeout(function(){timer=false;if(pending===attempt){record("nochange");pending=0}},1200);
    }
    if(enabled){
      try{
        var raw=window.sessionStorage.getItem("inv-diag-v1")||"[]";
        var saved=raw.length<=4096?JSON.parse(raw):[];
        if(Array.isArray(saved))history=saved.filter(valid).slice(-30).map(function(x){return x.v===undefined?{c:x.c}:{c:x.c,v:x.v}});
      }catch(e){}
      try{$("diagPanel").hidden=false;show()}catch(e){}
      try{
        $("galLabel").addEventListener("click",function(e){if(e.target===$("galLabel"))record("gallery")});
        ["gal","cam"].forEach(function(id){
          $(id).addEventListener("click",function(){pending=++sequence;away=false;timer=false;record("request")});
          $(id).addEventListener("cancel",function(){if(pending){record("cancel");pending=0}});
        });
        document.addEventListener("visibilitychange",function(){
          if(document.hidden){if(pending)away=true;record("hidden")}else{returned("visible")}
        });
        window.addEventListener("blur",function(){if(pending)away=true;record("blur")});
        window.addEventListener("focus",function(){returned("focus")});
      }catch(e){}
    }
    return {enabled:enabled,record:record,changed:function(){pending=0;record("change")}};
  })();
  function key(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
  function size(b){return b>=1048576?(b/1048576).toFixed(1)+" MB":Math.max(1,Math.round(b/1024))+" KB"}
  function say(t,cls){var s=$("status");s.textContent=t;s.className="status "+(cls||"")}
  function count(st){return queue.filter(function(q){return q.state===st}).length}
  function unsent(){return count("wait")+count("send")+count("fail")}
  function room(){return MAX-items.length-unsent()}
  function thumb(q){if(!q.thumb){try{q.thumb=URL.createObjectURL(q.file)}catch(e){q.thumb=""}}return q.thumb}
  function drop(q){if(q.thumb&&q.state!=="ok"){try{URL.revokeObjectURL(q.thumb)}catch(e){}}q.thumb=""}
  var WORD={wait:"بانتظار الإرسال",send:"جارٍ الإرسال…",fail:"لم تُرسل بعد",refused:"لم تُقبل"};
  function render(){
    $("n").textContent=String(items.length);
    var ul=$("list");ul.textContent="";
    items.forEach(function(it,i){
      var li=document.createElement("li");li.setAttribute("data-testid","inv-item");
      var img=document.createElement("img");img.alt="";if(thumbs[it.id])img.src=thumbs[it.id];li.appendChild(img);
      var sp=document.createElement("span");sp.className="grow";sp.textContent="فاتورة "+(i+1)+" · \\u2066"+size(it.bytes)+"\\u2069";li.appendChild(sp);
      var del=document.createElement("button");del.type="button";del.textContent="حذف";del.setAttribute("data-testid","inv-delete");
      del.disabled=busy;del.onclick=function(){remove(it.id)};li.appendChild(del);
      ul.appendChild(li);
    });
    var qu=$("queue");qu.textContent="";
    queue.forEach(function(q,i){
      if(q.state==="ok")return;
      var li=document.createElement("li");li.setAttribute("data-testid","inv-q-item");li.setAttribute("data-state",q.state);
      var img=document.createElement("img");img.alt="";var u=thumb(q);if(u)img.src=u;li.appendChild(img);
      var sp=document.createElement("span");sp.className="grow";
      sp.textContent="صورة "+(i+1)+" من "+queue.length+" · \\u2066"+size(q.file.size)+"\\u2069 — "+WORD[q.state]+(q.msg?": "+q.msg:"");
      li.appendChild(sp);
      if(q.state==="refused"||(q.state==="fail"&&!busy)){
        var x=document.createElement("button");x.type="button";x.textContent="إزالة";x.setAttribute("data-testid","inv-q-dismiss");
        x.onclick=function(){drop(q);queue=queue.filter(function(o){return o!==q});render()};li.appendChild(x);
      }
      qu.appendChild(li);
    });
    var total=queue.length,ok=count("ok"),fail=count("fail"),ref=count("refused");
    $("progress").textContent=total>1?("أُرسلت "+ok+" من "+total+(fail?" · لم تُرسل "+fail:"")+(ref?" · لم تُقبل "+ref:"")):"";
    $("retry").hidden=busy||over||fail===0;
    $("finish").disabled=busy||items.length===0||count("wait")>0||count("send")>0;
    $("cam").disabled=$("gal").disabled=busy||over||room()<=0;
  }
  function closed(msg){
    over=true;busy=false;
    var left=unsent();
    $("live").hidden=true;var d=$("done");d.hidden=false;d.className="err";
    d.textContent=msg+" وصل إلى الكمبيوتر "+items.length+" فاتورة"+(left?"، و"+left+" صور لم تصل — صوّرها في جلسة جديدة.":".");
  }
  function summary(){
    var ok=count("ok"),fail=count("fail"),ref=count("refused");
    if(queue.length===1){
      var q=queue[0];
      if(q.state==="ok"){say("✔ استُلمت الفاتورة رقم "+items.length+" على الكمبيوتر.","ok");return}
      if(q.state==="refused"){say(q.msg||"لم تُقبل الصورة.","err");return}
    }
    var t=ok?"✔ استُلمت "+ok+" صور على الكمبيوتر.":"";
    if(fail)t+=(t?" ":"")+"لم تُرسل "+fail+" — تحقق من شبكة المحل ثم اضغط «إعادة المحاولة».";
    if(ref)t+=(t?" ":"")+"لم تُقبل "+ref+" (السبب بجانب كل صورة).";
    say(t,fail||ref?"err":"ok");
  }
  function pump(){
    if(over)return;
    var q=null;for(var i=0;i<queue.length;i++){if(queue[i].state==="wait"){q=queue[i];break}}
    if(!q){busy=false;summary();$("another").hidden=!(count("ok")>0&&count("fail")===0&&room()>0);render();return}
    diag.record("queue");
    busy=true;q.state="send";q.msg="";$("another").hidden=true;
    say(queue.length>1?"جارٍ إرسال الصورة "+(queue.indexOf(q)+1)+" من "+queue.length+"…":"جارٍ الإرسال…");render();
    diag.record("send");
    fetch(base+"/invoice",{method:"POST",headers:{"X-Capture-Key":q.key},body:q.file}).then(function(r){
      diag.record("response",r.status);
      return r.json().then(function(j){return{status:r.status,j:j}},function(){return{status:r.status,j:{ok:false,message:"تعذّر الإرسال."}}});
    }).then(function(x){
      if(x.j.ok&&x.status!==404)diag.record("ok");else diag.record("rejected");
      if(x.status===404){q.state="fail";closed(x.j.message||"انتهت هذه الجلسة. اطلب رمزاً جديداً من الكمبيوتر.");return}
      if(x.j.ok){
        q.state="ok";
        if(!items.some(function(i){return i.id===x.j.id}))items.push({id:x.j.id,bytes:q.file.size});
        if(!thumbs[x.j.id])thumbs[x.j.id]=thumb(q);else if(q.thumb&&q.thumb!==thumbs[x.j.id]){try{URL.revokeObjectURL(q.thumb)}catch(e){}}
        pump();return;
      }
      if(x.status>=500){q.state="fail";q.msg=x.j.message||"";busy=false;summary();render();return}
      q.state="refused";q.msg=x.j.message||"تعذّر الإرسال.";
      if(x.j.code==="LIMIT")queue.forEach(function(o){if(o.state==="wait"){o.state="refused";o.msg=q.msg}});
      pump();
    },function(){
      diag.record("network");
      q.state="fail";q.msg="";busy=false;
      say("تعذّر الإرسال — تحقق من اتصال الهاتف بشبكة المحل ثم اضغط «إعادة المحاولة».","err");
      render();
    });
  }
  // OWNER REAL-PHONE BUG (Samsung Internet, 9879dcf): after choosing 3 gallery photos the page came back unchanged
  // and the till received NO request at all. Not yet reproduced off the device, so this does not guess a cause:
  // it makes every way of coming back VISIBLE — a reload while the picker was open (flag kept in sessionStorage),
  // an empty selection, a handler error — so the page never returns silently and the retest names the cause.
  var store=null;try{store=window.sessionStorage}catch(x){store=null}
  function flag(v){try{if(store){if(v)store.setItem("inv-picking",String(Date.now()));else store.removeItem("inv-picking")}}catch(x){}}
  function shown(msg){say(msg,"err");try{render()}catch(x){}}
  function pick(e){
    diag.changed();
    flag(false);
    try{pickNow(e)}catch(err){busy=false;shown(diag.enabled?"تعذّر قراءة الصور المختارة على هذا الهاتف.":"تعذّر قراءة الصور المختارة على هذا الهاتف ("+String(err&&err.message||err).slice(0,80)+"). جرّب صورة واحدة، أو زر «تصوير فاتورة».")}
  }
  function pickNow(e){
    var fs=Array.prototype.slice.call(e.target.files||[]);e.target.value="";
    diag.record("files",Math.min(fs.length,9999));
    if(!fs.length){shown("لم يصل من المعرض أي صورة إلى هذه الصفحة. جرّب صورة واحدة، أو زر «تصوير فاتورة».");return}
    if(busy||over)return;
    // A new pick starts a new pass; photos of the last pass that still failed stay and are retried with it.
    queue=queue.filter(function(q){if(q.state==="fail")return true;drop(q);return false});
    var r=room(),ln=$("limitNote");
    if(fs.length>r){
      ln.textContent="اخترت "+fs.length+" صور، والحد "+MAX+" فاتورة في الدفعة — "+(r>0?"تُرسل أول "+r+" فقط.":"لا مكان لصور أخرى.");
      ln.hidden=false;fs=fs.slice(0,Math.max(0,r));
    }else{ln.hidden=true;ln.textContent=""}
    queue.forEach(function(q){if(q.state==="fail")q.state="wait"});
    fs.forEach(function(f){queue.push({file:f,key:key(),state:"wait",msg:"",thumb:""})});
    pump();
  }
  $("cam").addEventListener("change",pick);
  $("gal").addEventListener("change",pick);
  // The picker is opened by a tap on the label (or the input itself): remember it, so a page that the browser
  // RELOADED while the gallery was open can say so instead of showing an unchanged page.
  $("camLabel").addEventListener("click",function(){flag(true)});
  $("galLabel").addEventListener("click",function(){flag(true)});
  try{
    var was=store&&store.getItem("inv-picking");
    if(was&&Date.now()-Number(was)<15*60*1000){flag(false);setTimeout(function(){shown(diag.enabled?"أُعيد تحميل الصفحة بعد طلب اختيار الصور وقبل تسجيل تغيير؛ السبب غير معروف.":"أُعيد تحميل الصفحة أثناء اختيار الصور فضاعت الصور المختارة (المتصفح أغلقها لتوفير الذاكرة). اختر صورة واحدة أو صورتين في كل مرة، أو استعمل «تصوير فاتورة».")},0)}
  }catch(x){}
  window.addEventListener("error",function(ev){shown(diag.enabled?"حدث خطأ في الصفحة.":"خطأ في الصفحة: "+String(ev&&ev.message||"").slice(0,100))});
  window.addEventListener("unhandledrejection",function(ev){shown(diag.enabled?"حدث خطأ في الصفحة.":"خطأ في الصفحة: "+String(ev&&ev.reason&&ev.reason.message||ev&&ev.reason||"").slice(0,100))});
  $("retry").onclick=function(){queue.forEach(function(q){if(q.state==="fail")q.state="wait"});pump()};
  $("another").onclick=function(){$("another").hidden=true;say("");$("cam").click()};
  function remove(id){
    if(busy||!confirm("حذف هذه الصورة من الدفعة؟"))return;
    busy=true;render();
    fetch(base+"/invoice/"+id+"/delete",{method:"POST"}).then(function(r){return r.json().then(function(j){return{status:r.status,j:j}})}).then(function(x){
      busy=false;
      if(x.status===404&&x.j.code==="SESSION_CLOSED"){closed(x.j.message);return}
      if(x.j.ok){items=items.filter(function(i){return i.id!==id});if(thumbs[id]){URL.revokeObjectURL(thumbs[id]);delete thumbs[id]}say("حُذفت الصورة من الدفعة.","ok")}
      else say(x.j.message||"تعذّر الحذف.","err");
      render();
    },function(){busy=false;say("تعذّر الحذف — تحقق من الشبكة.","err");render()});
  }
  $("finish").onclick=function(){
    var f=count("fail");
    if(f&&!confirm(f+" صور لم تُرسل بعد ولن تصل إلى الكمبيوتر. الإنهاء بدونها؟"))return;
    busy=true;render();say("جارٍ الإنهاء…");
    fetch(base+"/finish",{method:"POST"}).then(function(r){return r.json().then(function(j){return{status:r.status,j:j}})}).then(function(x){
      if(x.j.ok){over=true;$("live").hidden=true;var d=$("done");d.hidden=false;d.textContent="✔ أُرسلت "+items.length+" فاتورة إلى الكمبيوتر. تابع المراجعة هناك — يمكنك إغلاق هذه الصفحة.";return}
      busy=false;if(x.status===404){closed(x.j.message);return}say(x.j.message||"تعذّر الإنهاء.","err");render();
    },function(){busy=false;say("تعذّر الإنهاء — تحقق من الشبكة ثم اضغط «إنهاء» مرة أخرى.","err");render()});
  };
  render();
  diag.record("init");
})();
</script>
</body>
</html>
`;
}

/**
 * DEC-35z17 (owner: ONE «من الهاتف» button): the Phone Companion's landing page — the choice is made HERE,
 * on the phone. A tap POSTs `/choose/product` or `/choose/invoice`; the till prepares that purpose and LOCKS
 * the session to it, then this page reloads into the product form or the invoice page. A second, different
 * choice is refused by the till (a fresh code is needed), so a tap cannot widen what the session may do.
 */
export function renderPhoneLandingPage(): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>من الهاتف — عالضبط</title>
<style>
  [hidden]{display:none!important}
  body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;line-height:1.5;background:#fafafa;color:#1b1b1b}
  h1{font-size:20px;margin:0 0 4px}
  .muted{color:#555;font-size:14px;margin:0 0 16px}
  .choice{display:block;width:100%;box-sizing:border-box;padding:20px 16px;margin:12px 0;font-size:20px;border-radius:12px;border:1px solid #0a7d3a;background:#fff;text-align:center;font-weight:700}
  .choice small{display:block;font-weight:400;font-size:14px;color:#555;margin-top:4px}
  .choice[disabled]{opacity:.5}
  .err{color:#b00020}
</style>
<body>
<h1>عالضبط — من الهاتف</h1>
<p class="muted">ماذا تريد أن تفعل؟ اختر مرة واحدة لهذا الرمز.</p>
<button type="button" class="choice" id="p" data-testid="companion-choose-product">إضافة صنف<small>اسم، سعر، باركود وصورة صنف جديد</small></button>
<button type="button" class="choice" id="i" data-testid="companion-choose-invoice">تصوير فواتير مورّدين<small>صورة لكل فاتورة، وتراجعها على الكمبيوتر</small></button>
<p class="err" id="e" role="status" data-testid="companion-status"></p>
<script>
(function(){
  var base=location.pathname.replace(/\\/$/,"");
  function go(what){
    document.getElementById("p").disabled=document.getElementById("i").disabled=true;
    document.getElementById("e").textContent="";
    fetch(base+"/choose/"+what,{method:"POST"}).then(function(r){return r.json().then(function(j){return{status:r.status,j:j}})}).then(function(x){
      if(x.j.ok){location.reload();return}
      document.getElementById("e").textContent=x.j.message||"تعذّر الاختيار.";
      if(x.status!==409&&x.status!==404){document.getElementById("p").disabled=document.getElementById("i").disabled=false}
    },function(){
      document.getElementById("e").textContent="تعذّر الاتصال بالكمبيوتر — تحقق من شبكة المحل ثم حاول مرة أخرى.";
      document.getElementById("p").disabled=document.getElementById("i").disabled=false;
    });
  }
  document.getElementById("p").onclick=function(){go("product")};
  document.getElementById("i").onclick=function(){go("invoice")};
})();
</script>
</body>
</html>
`;
}
