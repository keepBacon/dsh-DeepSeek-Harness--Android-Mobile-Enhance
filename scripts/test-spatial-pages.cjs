'use strict';
/* Parse every lab page's scripts without executing them or requiring a browser. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../app/src/main/assets/labs');
const pages=fs.readdirSync(root).filter(n=>/^spatial-lab(?:-v[0-9]+)?\.html$/.test(n)).sort();
assert.deepEqual(pages,['spatial-lab-v2.html','spatial-lab-v3.html','spatial-lab-v4.html','spatial-lab.html']);
let inline=0,external=0;
for(const file of pages){
  const html=fs.readFileSync(path.join(root,file),'utf8');
  // All pages are designed to work offline with their own packaged scripts.
  assert.doesNotMatch(html,/\b(?:src|href)\s*=\s*["']\s*(?:https?:|\/\/|javascript:)/i,file);
  assert.doesNotMatch(html,/<(?:iframe|object|embed|base)\b/i,file);
  let scripts=0;
  const tags=/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for(const match of html.matchAll(tags)){
    scripts++;
    const [,attributes,body]=match;
    const source=attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if(source){
      assert.match(source[1],/^spatial(?:-core|-v[2-4])\.js$/);
      assert.equal(body.trim(),'',"script tag must not contain ignored inline body: "+file);
      const resolved=path.resolve(root,source[1]);
      assert.equal(path.dirname(resolved),root);
      assert.ok(fs.existsSync(resolved),'missing script '+source[1]+' from '+file);
      external++;
    }else{
      assert.ok(body.trim().length>0,'empty inline script in '+file);
      new vm.Script(body,{filename:file+'#inline'});
      inline++;
    }
  }
  assert.ok(scripts>=2,'no working scripts on '+file);
}
console.log('Spatial HTML: '+pages.length+' pages, '+inline+' inline syntax checks, '+external+' packaged dependencies PASS');
