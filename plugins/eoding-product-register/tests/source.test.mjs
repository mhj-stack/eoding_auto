import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readSource, validatePublicUrl } from '../src/source.mjs';

const publicResolver = async () => [{address:'93.184.216.34',family:4}];
const originalHosts = process.env.EODING_SOURCE_HOSTS;
delete process.env.EODING_SOURCE_HOSTS;
process.on('exit', () => { if(originalHosts !== undefined) process.env.EODING_SOURCE_HOSTS = originalHosts; });

for (const input of [
  'file:///etc/passwd','ftp://example.com','data:text/html,hello','javascript:alert(1)',
  'https://user:pass@example.com','http://localhost','http://localhost.',
  'http://x.localhost','http://service.local','http://metadata.google.internal','http://printer',
  'http://0.0.0.0','http://10.0.0.1','http://100.64.0.1','http://127.0.0.1',
  'http://127.1','http://2130706433','http://0x7f000001','http://0177.0.0.1',
  'http://169.254.169.254','http://172.16.0.1','http://192.168.1.1',
  'http://192.0.0.1','http://192.0.2.1','http://192.88.99.1','http://198.18.1.1',
  'http://198.51.100.1','http://203.0.113.1','http://224.0.0.1','http://255.255.255.255',
  'http://[::]','http://[::1]','http://[fc00::1]','http://[fe80::1]','http://[ff02::1]',
  'http://[::ffff:127.0.0.1]','http://[::ffff:7f00:1]','http://[::ffff:8.8.8.8]',
  'http://[64:ff9b::7f00:1]','http://[2002:7f00:1::]','http://[2001:db8::1]',
  'http://[2001::1]','http://[3fff::1]',
]) test('reject unsafe URL '+input, async () => {
  await assert.rejects(validatePublicUrl(input,{resolver:publicResolver}));
});

test('accept public literal v4 and global-unicast v6', async () => {
  for(const input of ['https://8.8.8.8','https://[2606:4700:4700::1111]']) {
    assert.equal((await validatePublicUrl(input)).protocol,'https:');
  }
});
test('lookup requests all answers; normalized public hostname works', async () => {
  const result = await validatePublicUrl('https://EXAMPLE.COM./path',{resolver:async (host,options) => {
    assert.equal(host,'example.com'); assert.deepEqual(options,{all:true,verbatim:true});
    return publicResolver();
  }});
  assert.equal(result.pathname,'/path');
});
test('reject mixed, empty, malformed, failed and private DNS answers', async () => {
  for (const answers of [[],[{address:'10.0.0.1'}],[{address:'8.8.8.8'},{address:'::1'}],
    [{address:'8.8.8.8'},{address:'169.254.1.1'}],[{address:'not-an-ip'}],null]) {
    await assert.rejects(validatePublicUrl('https://example.com',{resolver:async()=>answers}));
  }
  await assert.rejects(validatePublicUrl('https://example.com',{resolver:async()=>{throw Error('DNS');}}),/DNS lookup failed/);
});
test('exact allowlist applies to hostname and cannot override environment', async () => {
  process.env.EODING_SOURCE_HOSTS='example.com';
  try {
    await validatePublicUrl('https://example.com',{resolver:publicResolver});
    await assert.rejects(validatePublicUrl('https://sub.example.com',{resolver:publicResolver}),/allowlist/);
    await assert.rejects(validatePublicUrl('https://example.net',{hosts:['example.net'],resolver:publicResolver}),/allowlist/);
    await assert.rejects(validatePublicUrl('https://example.com',{hosts:['example.net'],resolver:publicResolver}),/allowlist/);
    await assert.rejects(validatePublicUrl('https://example.com',{hosts:['*.example.com'],resolver:publicResolver}),/wildcards/);
  } finally { delete process.env.EODING_SOURCE_HOSTS; }
});
test('reader rejects unsafe URL and excessive output limits before launch', async () => {
  await assert.rejects(readSource('http://127.0.0.1'),/nonpublic/);
  await assert.rejects(readSource('https://example.com',{maxTextLength:80001}),/maxTextLength/);
  await assert.rejects(readSource('https://example.com',{maxLinks:101}),/maxLinks/);
  await assert.rejects(readSource('https://example.com',{navigationTimeoutMs:30001}),/navigationTimeoutMs/);
});

// No external network: a real browser renders synthetic public-IP routes, whose fetches
// are replaced with in-memory responses. No local server or DNS bypass is needed.
test('isolated browser extraction, truncation, redirect and subrequest guards', async t => {
  const launch = chromium.launch.bind(chromium);
  let probe;
  try { probe = await launch({headless:true}); }
  catch(error) {
    if (/Executable doesn't exist|browserType.launch.*executable/i.test(error.message)) {
      t.skip('Chromium binary missing; install with npx playwright install chromium'); return;
    }
    throw error;
  }
  await probe.close();
  let html = '<title>Fixture</title><nav>Excluded</nav><main><h1>Product</h1><p>'+ 'x'.repeat(81000) +
    '</p><p hidden>SECRET HIDDEN</p><details><summary>Details</summary>COLLAPSED SECRET</details>' +
    Array.from({length:105},(_,i)=>'<a href="https://8.8.8.8/'+i+'">Link '+i+'</a>').join('')+
    '<img src="http://127.0.0.1/private"><script>fetch("https://8.8.8.8/post",{method:"POST"}).catch(()=>{});new WebSocket("wss://8.8.8.8/socket");</script></main>';
  let redirect = false;
  let contextOptions;
  const fetched = [];
  const browsers = [];
  t.mock.method(chromium,'launch',async options => {
    const browser = await launch(options); browsers.push(browser);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      contextOptions=options;
      const context=await newContext(options);
      const route = context.route.bind(context);
      context.route = (pattern,handler) => route(pattern,real => handler({
        request:()=>real.request(),
        abort:reason=>real.abort(reason),
        fetch:async options=>{
          assert.equal(options.maxRedirects,0);
          fetched.push(real.request().url());
          if (redirect === 'chain') return {status:()=>302,headers:()=>({location:
            real.request().url().includes('93.184.216.34') ? 'https://8.8.4.4/hop' :
            'http://169.254.169.254/latest/meta-data'})};
          if (redirect === 'download') return {status:()=>200,headers:()=>({'content-disposition':'attachment; filename="source.bin"'})};
          return {status:()=>redirect?302:200,headers:()=>redirect?
            {location:'http://169.254.169.254/latest/meta-data'}:{'content-type':'text/html'}};
        },
        fulfill:options=>options.response ? real.fulfill({status:options.response.status(),headers:options.headers,body:html}) : real.fulfill(options),
      }));
      return context;
    };
    return browser;
  });
  try {
    const result = await readSource('https://93.184.216.34/',{timeoutMs:15000});
    assert.equal(result.untrusted,true); assert.equal(result.title,'Fixture');
    assert.equal(result.status,'needs-review'); assert.equal(result.coverage,'visible-text-only');
    assert.ok(result.reviewReasons.length>0);
    assert.equal(result.text.length,80000); assert.equal(result.links.length,100);
    assert.equal(result.truncated,true); assert.ok(!result.text.includes('Excluded'));
    assert.ok(!result.text.includes('SECRET HIDDEN'));
    assert.ok(result.warnings.some(x=>x.includes('Non-GET/HEAD')));
    assert.ok(result.warnings.some(x=>x.includes('nonpublic')));
    assert.ok(result.warnings.some(x=>x.includes('WebSocket')));
    assert.equal(contextOptions.serviceWorkers,'block'); assert.equal(contextOptions.acceptDownloads,false);
    assert.deepEqual(fetched,['https://93.184.216.34/']);
    assert.ok(browsers.every(browser=>!browser.isConnected()));
    html='<title>Body fallback</title><p>Visible body</p><p hidden>Secret</p><details><summary>Details</summary>Collapsed secret</details>';
    const fallback=await readSource('https://93.184.216.34/',{timeoutMs:15000});
    assert.ok(fallback.text.includes('Visible body')); assert.ok(fallback.text.includes('Details'));
    assert.ok(!fallback.text.includes('Secret')); assert.ok(!fallback.text.includes('Collapsed secret'));
    assert.equal(fallback.truncated,false); assert.equal(fallback.status,'read');
    html='<title>Incomplete</title><p>가격 NaN원</p>';
    const incomplete=await readSource('https://93.184.216.34/',{timeoutMs:15000});
    assert.equal(incomplete.status,'needs-review');assert.ok(incomplete.reviewReasons.some(x=>x.includes('placeholder')));
    redirect=true;
    await assert.rejects(readSource('https://93.184.216.34/',{timeoutMs:15000}),/nonpublic/);
    assert.ok(fetched.every(url=>url==='https://93.184.216.34/'));
    redirect='chain';
    await assert.rejects(readSource('https://93.184.216.34/',{timeoutMs:15000}),/nonpublic/);
    assert.ok(fetched.includes('https://8.8.4.4/hop'));
    assert.ok(!fetched.some(url=>url.includes('169.254')));
    redirect='download';
    await assert.rejects(readSource('https://93.184.216.34/',{timeoutMs:15000}),/Download response blocked/);
    assert.ok(browsers.every(browser=>!browser.isConnected()));
  } finally { await Promise.all(browsers.map(browser=>browser.close())); }
});

test('whole-operation deadline closes a late-launching browser', async t => {
  let closed=false;
  t.mock.method(chromium,'launch',async()=>{
    await new Promise(resolve=>setTimeout(resolve,40));
    return {close:async()=>{closed=true;}};
  });
  await assert.rejects(readSource('https://8.8.8.8/',{timeoutMs:10}),/timed out/);
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(closed,true);
});
