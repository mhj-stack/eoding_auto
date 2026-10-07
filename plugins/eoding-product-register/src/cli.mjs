#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildPlan, buildBatchPlan, validateProduct } from './core.mjs';
import { readSource } from './source.mjs';
import { buildDeparturePlan } from './departure-plan.mjs';
import { prepareDepartureCandidate as prepareDeparture } from './departure-candidate.mjs';
import { readWorkbook } from './workbook.mjs';
import { createProductSourceSession } from './product-source.mjs';
import { EodingBrowser } from './browser.mjs';
import { EodingWorkflow, ImportOptions } from './workflow.mjs';
import { buildIntake } from './intake.mjs';
import { ProductSessionStore } from './product-session.mjs';
import { startProductReviewUI } from './product-review-ui.mjs';
const sessionStore = () => {
  if (!process.env.EODING_DATA_DIR?.trim()) throw new Error('전용 비공개 폴더 EODING_DATA_DIR을 명시하세요');
  return new ProductSessionStore(process.env.EODING_DATA_DIR);
};
const [command,arg,...rest]=process.argv.slice(2);
const print=x=>console.log(JSON.stringify(x,null,2));
const load=async file=>{if(!file)throw new Error('상품 JSON 경로가 필요합니다');return JSON.parse(await readFile(resolve(file),'utf8'));};
const sessionSourceOptions = args => {
  let scope, sheet, startRow, rowCount;
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--scope') { if (scope !== undefined || ++index >= args.length) throw new Error('--scope=full 또는 --scope=basic,shell,days,departures를 명시하세요'); scope = args[index]; }
    else if (value.startsWith('--scope=')) { if (scope !== undefined) throw new Error('--scope는 한 번만 지정하세요'); scope = value.slice('--scope='.length); }
    else positional.push(value);
  }
  if (positional.length > 3) throw new Error('session-source는 [sheet] [startRow] [rowCount]와 --scope만 지원합니다');
  [sheet, startRow, rowCount] = positional;
  const parsedScope = scope === undefined || scope === 'full' ? scope : scope.split(',').filter(Boolean);
  if (scope !== undefined && (scope !== 'full' && (!parsedScope.length || parsedScope.length !== scope.split(',').length))) throw new Error('실행 범위가 비어 있습니다');
  return { scope: parsedScope, sheet, ...(startRow === undefined ? {} : { startRow: Number(startRow) }), ...(rowCount === undefined ? {} : { rowCount: Number(rowCount) }) };
};
try {
  switch(command) {
    case 'mcp': await import('./mcp.mjs'); break;
    case 'validate': {const r=validateProduct(await load(arg));print(r);if(!r.readyForReview)process.exitCode=2;break;}
    case 'plan': {const p=buildPlan(await load(arg));print(p);if(!p.readyForReview)process.exitCode=2;break;}
    case 'plan-departures': {const result=buildDeparturePlan(await load(arg),await load(rest[0]));print(result);if(!result.readyForReview)process.exitCode=2;break;}
    case 'batch-plan': {const p=buildBatchPlan(await load(arg));print(p);if(!p.readyForReview)process.exitCode=2;break;}
    case 'intake': {print(buildIntake(await load(arg)));break;}
    case 'session-source': {
      if (!arg) throw new Error('공개 URL 또는 xlsx/xlsm 경로가 필요합니다');
      const options = sessionSourceOptions(rest);
      print(await createProductSourceSession({ ...( /^https?:\/\//i.test(arg) ? { url:arg } : { filePath:arg }), ...options })); break;
    }
    case 'session-normalize': { if (!arg || !rest[0]) throw new Error('세션 ID와 에이전트 내부 정규화 JSON 경로가 필요합니다'); print(await sessionStore().normalize(arg,await load(rest[0]))); break; }
    case 'session-get': { print(await sessionStore().get(arg)); break; }
    case 'session-preflight': { print(await sessionStore().preflight(arg)); break; }
    case 'session-demo': {
      const store=sessionStore();
      const session=await store.create({ source:{kind:'excel',label:'synthetic-demo.xlsx',evidence:{untrusted:true,rows:[{row:1,values:['synthetic demo only']}] }},normalized:await load('examples/product.json') });
      print(await store.preflight(session.id)); break;
    }
    case 'session-run': {
      if (!arg || !rest[0]) throw new Error('세션 ID와 에이전트 내부 실행설정 경로가 필요합니다');
      const {ProductRuntime}=await import('./product-runtime.mjs');
      const runtime=new ProductRuntime({dataDir:process.env.EODING_DATA_DIR});
      const config=await load(rest[0]);
      const checked=await runtime.store.preflight(arg);
      if (!checked.canExecute) throw new Error('등록 차단: '+checked.blockers.map(b=>b.stage+': '+b.reason).join('; '));
      const close=()=>runtime.close(); const exit=()=>{void close().finally(()=>process.exit(0));};
      try {
        print(await runtime.open());
        print(await runtime.review({sessionId:arg,input:config.input,expectedAccountName:config.expectedAccountName}));
        process.once('SIGINT',exit);process.once('SIGTERM',exit);
        await new Promise(()=>{});
      } finally {process.off('SIGINT',exit);process.off('SIGTERM',exit);await close();}
      break;
    }
    case 'session-review': {
      const ui=await startProductReviewUI({store:sessionStore(),sessionId:arg}); console.log(ui.url);
      const close=async()=>{await ui.close().catch(()=>{});}; const exit=()=>{void close().finally(()=>process.exit(0));};
      process.once('SIGINT',exit);process.once('SIGTERM',exit);
      try { await new Promise(()=>{}); } finally { process.off('SIGINT',exit);process.off('SIGTERM',exit);await close(); }
      break;
    }
    case 'read-url': if(!arg)throw new Error('URL 필요');else print(await readSource(arg));break;
    case 'read-excel': if(!arg)throw new Error('파일 경로 필요');else print(await readWorkbook(arg,{sheet:rest[0],startRow:rest[1]?Number(rest[1]):1,rowCount:rest[2]?Number(rest[2]):100}));break;
    case 'review': {const flow=new EodingWorkflow(new EodingBrowser());const r=await flow.getReview(arg);print(r);break;}
    case 'approve': {
      if(!stdin.isTTY || !stdout.isTTY)throw new Error('승인은 사용자가 직접 실행한 대화형 터미널에서만 가능합니다');
      const flow=new EodingWorkflow(new EodingBrowser());const r=await flow.store.get(arg);
      print({id:r.id,status:r.status,summary:r.payload.summary,screenshot:r.payload.screenshot,expiresAt:r.expiresAt});
      const rl=createInterface({input:stdin,output:stdout});
      try{const tenant=await rl.question('현재 ERP 화면에서 직접 확인한 회사명을 입력: ');if(tenant!==r.payload.product.company.tenant)throw new Error('ERP 회사명 확인이 일치하지 않습니다');const answer=await rl.question(`계정·대상·화면을 직접 확인한 경우 APPROVE ${r.id} 입력: `);if(answer!==`APPROVE ${r.id}`)throw new Error('승인하지 않았습니다');await flow.store.approve(r.id,r.hash,{tenantObserved:tenant,method:'interactive-cli-tenant-readback'});print(await flow.getReview(r.id));}finally{rl.close();}
      break;
    }
    case 'reconcile': {
      if(!stdin.isTTY || !stdout.isTTY)throw new Error('대사는 사용자가 직접 실행한 터미널에서만 가능합니다');
      const flow=new EodingWorkflow(new EodingBrowser());const r=await flow.store.get(arg);print(await flow.getReview(arg));
      const rl=createInterface({input:stdin,output:stdout});
      try{const tenant=await rl.question('ERP에서 직접 확인한 회사명: ');if(tenant!==r.payload.product.company.tenant)throw new Error('회사 확인 불일치');const outcome=await rl.question('ERP 생성 확인은 COMPLETED, 생성되지 않았음을 확인했다면 NOT_CREATED 입력: ');if(!['COMPLETED','NOT_CREATED'].includes(outcome))throw new Error('대사 취소');const productId=outcome==='COMPLETED'?await rl.question('ERP에서 확인한 상품 ID: '):undefined;const note=await rl.question('직접 확인한 방법/결과 기록: ');await flow.store.reconcile(r.id,{outcome:outcome==='COMPLETED'?'completed':'aborted',...(productId?{productId}:{}),note});print(await flow.getReview(r.id));}finally{rl.close();}
      break;
    }
    case 'prepare-departure': {
      if(!stdin.isTTY || !stdout.isTTY)throw new Error('직접 조작할 대화형 터미널 필요. AI는 MCP eoding_prepare_departure를 사용하세요');
      const product=await load(arg),options=await load(rest[0]),target=await load(rest[1]),index=Number(rest[2]);
      const browser=new EodingBrowser(),rl=createInterface({input:stdin,output:stdout});
      try{print(await browser.open());await rl.question('직접 로그인하고 기존 비공개 대상 상품의 기본정보 화면에서 Enter: ');const current=await browser.ensurePage();await browser.assertERP(current);print(await prepareDeparture(current,product,options,target,index));await rl.question('입력만 완료됐고 저장하지 않았습니다. 검토 후 미저장 입력을 폐기하고 종료하려면 Enter: ');}finally{rl.close();await browser.close();}break;
    }
    case 'import-schedule': {
      if(!stdin.isTTY || !stdout.isTTY)throw new Error('일정표 실저장은 사용자가 직접 실행한 대화형 터미널에서만 가능합니다');
      if(!process.env.EODING_DATA_DIR?.trim())throw new Error('전용 비공개 폴더 EODING_DATA_DIR을 명시하세요');
      const product=await load(arg),target=await load(rest[0]),schedule=await load(rest[1]);
      const {ScheduleSessionBrowser}=await import('./schedule-session.mjs');
      const {LiveScheduleWorkflow}=await import('./schedule-live-workflow.mjs');
      const {runLiveScheduleCommand}=await import('./schedule-live-command.mjs');
      const browser=new ScheduleSessionBrowser({dataDir:process.env.EODING_DATA_DIR});
      const flow=new LiveScheduleWorkflow(browser),rl=createInterface({input:stdin,output:stdout});
      try{await runLiveScheduleCommand({product,target,schedule,browser,flow,prompt:question=>rl.question(question),report:print});}
      finally{rl.close();await browser.close();}
      break;
    }
    case 'review-schedule': {
      if(!process.env.EODING_DATA_DIR?.trim())throw new Error('전용 비공개 폴더 EODING_DATA_DIR을 명시하세요');
      const product=await load(arg),target=await load(rest[0]),schedule=await load(rest[1]);
      const {ScheduleSessionBrowser}=await import('./schedule-session.mjs');
      const {LiveScheduleWorkflow}=await import('./schedule-live-workflow.mjs');
      const {startScheduleReviewUI}=await import('./schedule-review-ui.mjs');
      const browser=new ScheduleSessionBrowser({dataDir:process.env.EODING_DATA_DIR});
      let ui,closing=false;
      const close=async()=>{if(closing)return;closing=true;await ui?.close().catch(()=>{});await browser.close().catch(()=>{});};
      const exit=()=>{void close().finally(()=>process.exit(0));};
      try {
        await browser.open();
        const flow=new LiveScheduleWorkflow(browser);
        ui=await startScheduleReviewUI({product,target,schedule,browser,flow});
        console.log(ui.url);
        process.once('SIGINT',exit);process.once('SIGTERM',exit);
        await new Promise(()=>{});
      } finally {
        process.off('SIGINT',exit);process.off('SIGTERM',exit);await close();
      }
      break;
    }
    case 'import-day': {
      if(!stdin.isTTY || !stdout.isTTY)throw new Error('직접 조작할 대화형 터미널 필요. AI는 MCP 준비·승인 흐름을 사용하세요');
      const product=await load(arg),target=await load(rest[0]),day=Number(rest[1]);
      const browser=new EodingBrowser(),flow=new EodingWorkflow(browser),rl=createInterface({input:stdin,output:stdout});
      try{print(await browser.open());await rl.question('직접 로그인 후 대상 비공개 상품·일정표·빈 일차를 선택하고 Enter: ');
        const review=await flow.prepareScheduleDay(product,target,day);print(review);
        const tenant=await rl.question('ERP 화면에서 직접 확인한 회사명: ');if(tenant!==product.company.tenant)throw new Error('회사 확인 불일치');
        const answer=await rl.question(`현재 일차 텍스트·식사를 1회 저장하려면 APPROVE ${review.id} 입력: `);if(answer!==`APPROVE ${review.id}`)throw new Error('승인하지 않았습니다');
        await flow.store.approve(review.id,review.hash,{tenantObserved:tenant,method:'interactive-cli-tenant-readback'});print(await flow.execute(review.id));
      }finally{rl.close();await browser.close();}break;
    }
    case 'import-basic': {
      if(!stdin.isTTY || !stdout.isTTY)throw new Error('직접 조작할 터미널 필요. AI는 MCP 준비 도구와 사용자의 로컬 승인을 이용하세요');
      const product=await load(arg),options=ImportOptions.parse(await load(rest[0]));
      const browser=new EodingBrowser();const flow=new EodingWorkflow(browser);flow.validate(product,options);
      const rl=createInterface({input:stdin,output:stdout});
      const approve=async review=>{print(review);const tenant=await rl.question('현재 ERP 화면에서 직접 확인한 회사명을 입력: ');if(tenant!==product.company.tenant)throw new Error('ERP 회사명 확인이 일치하지 않습니다');const answer=await rl.question(`ERP 계정/기존 상품 중복/입력값을 검토했다면 APPROVE ${review.id} 입력: `);if(answer!==`APPROVE ${review.id}`)throw new Error('승인하지 않았습니다');await flow.store.approve(review.id,review.hash,{tenantObserved:tenant,method:'interactive-cli-tenant-readback'});return flow.execute(review.id);};
      try{print(await browser.open());await rl.question('직접 로그인하고 상품관리 목록에서 Enter (다른 기기 세션이 종료될 수 있습니다): ');print(await approve(await flow.requestStart(product,options)));print(await approve(await flow.prepareBasic(product,options)));}finally{rl.close();await browser.close();}
      break;
    }
    case 'prepare': throw new Error('새 흐름을 사용하세요: import-basic <product.json> <erp-options.json>, 또는 MCP eoding_prepare_basic');
    case 'login': {
      if(!stdin.isTTY)throw new Error('직접 조작할 터미널 필요. AI는 MCP browser 도구를 사용하세요');
      const browser=new EodingBrowser();const rl=createInterface({input:stdin,output:stdout});
      try {
        print(await browser.open());
        await rl.question('브라우저에서 직접 로그인 후 상품관리 목록을 열고 Enter: ');
        print(await browser.inspect());
        await rl.question('브라우저 종료 시 저장하지 않은 입력이 사라집니다. 종료하려면 Enter: ');
      }finally{rl.close();await browser.close();}
      break;
    }
    case 'commit': throw new Error('직접 commit은 제공하지 않습니다. MCP eoding_execute_review 또는 대화형 import-basic을 이용하세요. 일정/행사 저장은 미지원');
    default: console.log(`eoding-product-importer 0.5.0-alpha.2 (private basic-product save with local human approval)
Usage:
  node src/cli.mjs read-url https://public-product-page
  node src/cli.mjs read-excel ./input/products.xlsx [sheet] [startRow] [rowCount]
  node src/cli.mjs validate ./examples/product.json
  node src/cli.mjs plan ./examples/product.json
  node src/cli.mjs plan-departures ./input/product.json ./input/departure-options.json
  node src/cli.mjs batch-plan ./input/products.json
  node src/cli.mjs login
  node src/cli.mjs import-basic ./input/product.json ./input/erp-options.json
  node src/cli.mjs import-schedule ./input/product.json ./input/schedule-target.json ./input/schedule.json
    (experimental: explicit EODING_DATA_DIR, dedicated browser + human approval; live E2E not yet verified)
  node src/cli.mjs review-schedule ./input/product.json ./input/schedule-target.json ./input/schedule.json
    (opens a local human review page; explicit EODING_DATA_DIR required; does not require a TTY)
  node src/cli.mjs import-day ./input/product.json ./input/schedule-target.json 1
  node src/cli.mjs prepare-departure ./input/product.json ./input/departure-options.json ./input/departure-target.json 0
  node src/cli.mjs review <review-id>
  node src/cli.mjs approve <review-id>
  node src/cli.mjs reconcile <review-id>
  node src/cli.mjs intake ./input/internal-normalized-product.json
  node src/cli.mjs session-source <public-url|./input/product.xlsx> [sheet] [startRow] [rowCount] [--scope=full|basic,shell,days,departures]
    (default scope is full and remains blocked; explicit sheet/pagination is honestly partial evidence)
  node src/cli.mjs session-normalize <session-id> ./input/agent-internal-normalized-product.json
  node src/cli.mjs session-get <session-id>
  node src/cli.mjs session-preflight <session-id>
  node src/cli.mjs session-review <session-id>
  node src/cli.mjs session-run <session-id> ./input/agent-internal-execution-options.json
    (single local human approval; supported requested scope only; full product stays blocked)
  node src/cli.mjs session-demo
  node src/cli.mjs mcp
Environment: EODING_INPUT_DIR, EODING_DATA_DIR, EODING_PYTHON
No API key or built-in LLM: your AI interprets the evidence and creates ProductSchema JSON.`);
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
