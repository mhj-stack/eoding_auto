import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, lstat, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { readSource } from './source.mjs';
import { collectWorkbookEvidence } from './workbook-evidence.mjs';

const LIMIT=26*1024*1024;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const jobId=/^[a-f0-9-]{36}$/;
const labels={collecting:'자료 확인 중', 'needs-agent-review':'자료 확인 완료', failed:'자료 확인 실패'};
function render({csrf,ticket,jobs=[],job,message=''}){
 const status=job?.status==='collecting'?'자료 확인 중단 — 자동 재시도하지 않음':labels[job?.status];
 const questions=['회사·담당자와 대표도시','모든 일차·식사 및 이미지 출처','시즌 적용 출발일·성인/아동/유아 요금','왕복 항공·포함/불포함·미확정 정보'];
 return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>어딩 상품 세팅</title><style>
 *{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#18243a;font-family:system-ui,'Malgun Gothic',sans-serif;line-height:1.6}main{max-width:1000px;margin:auto;padding:36px 24px}header{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #dce3ee;padding-bottom:20px}.brand{font-weight:800;color:#1e57da;letter-spacing:-1px}h1{font-size:30px;line-height:1.25;margin:20px 0 10px}h2{font-size:20px;margin:0 0 12px}p{margin:8px 0}.small{font-size:13px;color:#57657a}.badge{border:1px solid #d3dced;border-radius:24px;padding:4px 12px;white-space:nowrap;font-size:12px}.steps{display:flex;gap:0;list-style:none;padding:16px 0;margin:0;flex-wrap:wrap}.steps li{padding:6px 18px 6px 0;color:#59687d}.steps li:first-child{color:#1e57da;font-weight:700}.grid{display:grid;grid-template-columns:1.25fr 1fr;gap:24px;margin-top:24px}section{background:white;padding:24px;border:1px solid #dce3ee;border-radius:12px;min-width:0}.notice{background:#f0f5ff;border-left:3px solid #346be5;padding:12px 16px;margin:16px 0}.warning{color:#8a3706;background:#fff5e9;padding:12px;border-radius:6px}label{display:block;font-weight:650;font-size:14px;margin:14px 0 6px}input{width:100%;padding:11px;border:1px solid #bfcbdd;border-radius:6px;font:inherit}button{font:inherit;border:0;background:#245fdf;color:white;padding:11px 18px;border-radius:7px;margin-top:14px;cursor:pointer}button:disabled{background:#e3e8f0;color:#67758a;cursor:not-allowed}.divider{border:0;border-top:1px solid #e3e8f0;margin:24px 0}a{color:#245fdf}ul{padding-left:20px}.history{margin-top:24px}article{padding:12px 0;border-bottom:1px solid #e7edf5;overflow-wrap:anywhere}.wrap{overflow-wrap:anywhere}@media(max-width:640px){main{padding:22px 16px}.grid{grid-template-columns:1fr}header{align-items:flex-start}h1{font-size:26px}section{padding:18px}.steps li{font-size:13px}}
 </style></head><body><main><header><div class="brand">EODING · 상품 세팅</div><span class="badge">직원용 준비 버전</span></header><h1>상품 자료에서 등록 준비까지</h1><p>링크 또는 엑셀을 넣어 주세요. 중간 파일이나 명령어를 직접 작성할 필요가 없습니다.</p><ol class="steps"><li>01 자료 읽기</li><li>02 누락사항 일괄 확인</li><li>03 한 번 승인</li><li>04 저장·결과 확인</li></ol><div class="notice"><strong>행사 제외 · 20분 목표</strong><br>기본정보, 기본전시 이미지, 상세, 전체 일정, 시즌이 대상입니다. 현재 자료 접수는 사용할 수 있고 통합 ERP 저장은 검증 중입니다. 20분 달성은 아직 실측하지 않았습니다.</div>${message?`<p class="warning">${esc(message)}</p>`:''}
 ${job?`<section class="wrap"><h2>${esc(status)}</h2><p><strong>${esc(job.source?.evidence?.title??job.source?.label)}</strong></p><p>작업번호: ${esc(job.id)}</p><p>자료 확인 시간: ${esc(((job.measurement?.sourceMs??0)/1000).toFixed(1))}초 · ERP 저장 전</p><p>원문 해석과 누락 확인이 필요합니다. 자료 접수만으로 상품이 등록되지는 않습니다.</p><p class="small">원문은 로컬 작업 폴더에 보관됩니다. 공개 웹페이지의 접힌 일정·항공 탭·이미지는 별도 수집/대조가 필요하며, 엑셀 수식은 저장된 캐시를 읽습니다.</p><button disabled>승인 후 전체 등록</button></section>`:''}
 <div class="grid"><section><h2>상품 자료 넣기</h2><form method="post" action="/intake"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="ticket" value="${ticket}"><label for="source-url">상품 링크</label><input id="source-url" name="url" type="url" placeholder="https://…" required maxlength="8192"><button type="submit">자료 읽기</button></form><hr class="divider"><form method="post" action="/intake" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="ticket" value="${ticket}"><label for="source-file">상품 엑셀</label><input id="source-file" name="workbook" type="file" accept=".xlsx,.xlsm" required><p class="small">xlsx / xlsm · 최대 25MB · 숨김 시트 포함 셀 자료 수집</p><button type="submit">엑셀 읽기</button></form></section><section><h2>등록 전 한 번에 확인</h2><ul>${questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul><p class="small">없는 요금·호텔·항공편은 만들어 채우지 않습니다. 확인이 필요한 값은 모아서 검토합니다.</p><hr class="divider"><h2>직원별 안전한 사용</h2><p>직원 본인 ERP 계정으로 로그인합니다. 다른 직원의 비밀번호나 로그인 파일을 복사하지 않습니다.</p><p class="small">이미 저장했는지 불명확할 때는 다시 등록하지 않고 먼저 서버 결과를 확인합니다. 기존 상품·행사는 임의 변경하지 않습니다.</p></section></div><section class="history"><h2>이 PC의 접수 내역</h2>${jobs.length?jobs.map(j=>`<article><a href="/job/${esc(j.id)}">${esc(j.source?.label)}</a><br><span class="small">${esc(j.status==='collecting'?'중단됨 · 확인 필요':labels[j.status]??j.status)} · ${esc(j.createdAt)}</span></article>`).join(''):'<p class="small">접수한 자료가 없습니다.</p>'}</section></main></body></html>`;
}
async function privateDirectory(folder){await mkdir(folder,{recursive:true,mode:0o700});const s=await lstat(folder);if(!s.isDirectory()||s.isSymbolicLink())throw Error('비공개 폴더를 확인하세요.');}
async function parseForm(req){
 const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>LIMIT)throw Error('파일은 25MB 이하만 지원합니다.');chunks.push(c);}
 const type=req.headers['content-type']??'';if(!/^(multipart\/form-data;|application\/x-www-form-urlencoded(?:;|$))/i.test(type))throw Error('지원하지 않는 요청입니다.');
 const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':type}}).formData();
 const out={};for(const [k,v]of form){if(Object.hasOwn(out,k)||!['csrf','ticket','url','workbook'].includes(k))throw Error('중복 또는 잘못된 입력입니다.');out[k]=v;}return out;
}
/** Read-only employee intake. Intentionally contains no ERP save/approval endpoint. */
export async function startStaffIntake({dataDir,readers={}}={}){
 if(typeof dataDir!=='string'||!dataDir.trim())throw Error('직원별 비공개 데이터 폴더가 필요합니다.');
 const root=path.resolve(dataDir);if(root===path.parse(root).root||root===homedir()||existsSync(path.join(root,'package.json'))||existsSync(path.join(root,'.git')))throw Error('전용 하위 폴더가 필요합니다.');
 await privateDirectory(root);const jobsDir=path.join(root,'staff-jobs'),uploads=path.join(root,'staff-input');await privateDirectory(jobsDir);await privateDirectory(uploads);
 let host,origin,busy=false,closed=false,launchUsed=false;const launchCapability=token();const sessions=new Map(),tickets=new Set();
 const save=async job=>{const dest=path.join(jobsDir,job.id+'.json'),tmp=dest+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(job,null,2),{flag:'wx',mode:0o600});await rename(tmp,dest);};
 const get=async id=>{if(!jobId.test(id))throw Error('잘못된 작업번호입니다.');const f=path.join(jobsDir,id+'.json');if((await lstat(f)).isSymbolicLink())throw Error('안전하지 않은 작업 경로입니다.');return JSON.parse(await readFile(f,'utf8'));};
 const list=async()=>{const names=(await readdir(jobsDir)).filter(n=>jobId.test(n.slice(0,-5))&&n.endsWith('.json'));const all=[];for(const n of names){const j=await get(n.slice(0,-5));all.push({id:j.id,source:{label:j.source?.label},status:j.status,createdAt:j.createdAt});}return all.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,25);};
 const server=http.createServer(async(req,res)=>{
 const send=(code,body,session)=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",...(session?{'Set-Cookie':`staff_intake=${session.id}; HttpOnly; SameSite=Strict; Path=/`}:{})});res.end(body);};
 if(req.headers.host!==host)return send(421,'허용되지 않은 호스트입니다.');
 if(closed)return send(410,'종료되었습니다.');
 const cookie=/\bstaff_intake=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie??'')?.[1];let session=sessions.get(cookie);
 const launch=/^\/\?launch=([a-f0-9]{64})$/.exec(req.url??'');
 if(req.method==='GET'&&launch&&!launchUsed&&equal(launch[1],launchCapability)){
  launchUsed=true;session={id:token(),csrf:token()};sessions.set(session.id,session);
  res.writeHead(303,{'Location':'/','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':`staff_intake=${session.id}; HttpOnly; SameSite=Strict; Path=/`});res.end();return;
 }
 if(!session)return send(403,'실행 파일이 연 본인 접수 화면을 사용하세요.');
 const page=async(job,message='')=>{const ticket=token();if(tickets.size>=500)tickets.delete(tickets.values().next().value);tickets.add(session.id+':'+ticket);return render({csrf:session.csrf,ticket,jobs:await list(),job,message});};
 try{
  if(req.method==='GET'&&req.url==='/')return send(200,await page(),session);
  const match=/^\/job\/([a-f0-9-]{36})$/.exec(req.url??'');if(req.method==='GET'&&match)return send(200,await page(await get(match[1])),session);
  if(req.method!=='POST'||req.url!=='/intake'||req.headers.origin!==origin)return send(403,'접수 화면에서 다시 시도하세요.',session);
  if(busy)return send(409,'자료를 확인 중입니다. 중복 접수하지 마세요.',session);
  const values=await parseForm(req);if(!equal(values.csrf,session.csrf)||typeof values.ticket!=='string'||!tickets.has(session.id+':'+values.ticket))return send(403,'접수 화면을 새로 열어 주세요.',session);
  const isUrl=typeof values.url==='string'&&values.url.length>0,isFile=values.workbook&&typeof values.workbook.arrayBuffer==='function';if(Boolean(isUrl)===Boolean(isFile))throw Error('링크 또는 엑셀 하나만 선택하세요.');
  let label,filePath;
  if(isUrl){const u=new URL(values.url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||values.url.length>8192)throw Error('공개 상품 링크만 지원합니다.');label=values.url;}
  else{label=path.basename(values.workbook.name.replaceAll('\\','/'));if(!/\.(xlsx|xlsm)$/i.test(label)||values.workbook.size>25*1024*1024||values.workbook.size===0)throw Error('25MB 이하의 xlsx/xlsm 파일만 지원합니다.');}
  tickets.delete(session.id+':'+values.ticket);busy=true;const started=Date.now();
  const job={id:randomUUID(),createdAt:new Date(started).toISOString(),scope:'product-only',eventCreation:false,status:'collecting',source:{kind:isUrl?'url':'excel',label},measurement:{start:'source-intake',startedAt:started,sourceMs:null,approvalWaitMs:0,endToEndMs:null,slaVerified:false}};
  try{
   await save(job);
   if(isFile){filePath=path.join(uploads,job.id+path.extname(label).toLowerCase());await writeFile(filePath,Buffer.from(await values.workbook.arrayBuffer()),{flag:'wx',mode:0o600});}
   const evidence=isUrl?await(readers.readSource??readSource)(values.url):await collectWorkbookEvidence(filePath,{inputDir:uploads,reader:readers.readWorkbook});
   job.source.evidence=evidence;job.source.digest=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');job.status='needs-agent-review';job.measurement.sourceMs=Date.now()-started;await save(job);
   return send(200,await page(job),session);
  }catch(error){job.status='failed';job.measurement.sourceMs=Date.now()-started;job.failure={stage:'source-read',message:'자료를 읽지 못했습니다. 원문 접근·파일 형식·설치 상태를 확인하세요. ERP 저장은 하지 않았습니다.'};await save(job);return send(400,await page(job,job.failure.message),session);}
  finally{busy=false;}
 }catch(error){return send(400,await page(null,'접수를 처리하지 못했습니다. 입력 형식과 파일 크기를 확인하세요. ERP 저장은 하지 않았습니다.'),session);}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:0,exclusive:true},resolve);});host='127.0.0.1:'+server.address().port;origin='http://'+host;
 return {url:origin+'/?launch='+launchCapability,close:async()=>{if(closed)return;if(busy)throw Error('자료 읽기가 끝난 후 종료하세요.');closed=true;sessions.clear();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}};
}
