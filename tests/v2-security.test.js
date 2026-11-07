'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {validEmail,configured,recoveryPageUrl,sendCustomerAccessEmail}=require('../lib/recovery-mailer');
const {renderLibraryPage}=require('../lib/v2-library');
test('email input must be a plausible address and no CRLF',()=>{
  assert.equal(validEmail('buyer@example.com'),true);
  for(const value of [undefined,'','buyer\n@example.com','bad-address','a@b','<buyer@example.com>'])assert.equal(validEmail(value),false);
});
test('recovery requires authenticated mail delivery configuration',()=>{
  const orig={RESEND_API_KEY:process.env.RESEND_API_KEY,RECOVERY_FROM_EMAIL:process.env.RECOVERY_FROM_EMAIL,BEYONDMYTHOS_PUBLIC_URL:process.env.BEYONDMYTHOS_PUBLIC_URL};
  try {delete process.env.RESEND_API_KEY;delete process.env.RECOVERY_FROM_EMAIL;delete process.env.BEYONDMYTHOS_PUBLIC_URL;assert.equal(configured(),false);}finally{for(const [k,v] of Object.entries(orig))v===undefined?delete process.env[k]:process.env[k]=v}
});
test('recovery mail delivers credential to mailbox rather than public caller',async()=>{
 const old={RESEND_API_KEY:process.env.RESEND_API_KEY,RECOVERY_FROM_EMAIL:process.env.RECOVERY_FROM_EMAIL,BEYONDMYTHOS_PUBLIC_URL:process.env.BEYONDMYTHOS_PUBLIC_URL};
 try {process.env.RESEND_API_KEY='test-secret-key';process.env.RECOVERY_FROM_EMAIL='orders@beyondmythos.com';process.env.BEYONDMYTHOS_PUBLIC_URL='https://beyondmythos.com';
 let calls=0;await sendCustomerAccessEmail({to:'buyer@example.com',token:'signed-token',fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://api.resend.com/emails');const payload=JSON.parse(init.body);assert.deepEqual(payload.to,['buyer@example.com']);assert.ok(payload.html.includes('signed-token'));return {ok:true}}});
 assert.equal(calls,1);assert.equal(new URL(recoveryPageUrl('signed-token')).pathname,'/library');}
 finally{for(const [k,v] of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v}
});
test('customer library noindex, uses textContent for user data',()=>{
 const html=renderLibraryPage();assert.ok(html.includes('noindex,nofollow'));assert.ok(html.includes('textContent'));assert.ok(html.includes('/api/customer/access?token='));
});
test('legacy recovery endpoints must not return access tokens directly',(t)=>{
 const serverPath=path.join(__dirname,'..','server.js');
 if(!fs.existsSync(serverPath)) return t.skip('Runs against the original server.js after integration');
 const source=fs.readFileSync(serverPath,'utf8');
 assert.match(source,/safeRecoveryEmail/);
 assert.match(source,/private access link will be sent/);
 assert.doesNotMatch(source,/res\.status\(202\)\.json\(result\);/);
});
