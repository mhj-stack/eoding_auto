import path from 'node:path';
import { ProductSessionStore } from './product-session.mjs';
import { ScheduleSessionBrowser } from './schedule-session.mjs';
import { EodingWorkflow } from './workflow.mjs';
import { ProductExecutionCoordinator, createProductLowLevelAdapters } from './product-execution.mjs';
import { startProductExecutionReviewUI } from './product-execution-ui.mjs';

/** Shared CLI/MCP runtime. Opening a review does not approve or execute it. */
export class ProductRuntime {
  constructor({dataDir, browser} = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('전용 비공개 폴더 EODING_DATA_DIR을 명시하세요');
    this.store = new ProductSessionStore(dataDir);
    this.browser = browser ?? new ScheduleSessionBrowser({dataDir:path.resolve(dataDir,'registration-browser')});
    this.identityReader = new EodingWorkflow(this.browser);
    this.ui = null;
    this.preparing = false;
  }
  async open() { return this.browser.open(); }
  async review({sessionId, input, expectedAccountName, ttlMs} = {}) {
    if (this.ui || this.preparing) throw new Error('등록 검토가 이미 열려 있습니다. 기존 검토를 종료하세요.');
    this.preparing = true;
    try {
      if (typeof expectedAccountName !== 'string' || !expectedAccountName.trim() || expectedAccountName !== expectedAccountName.trim()) throw new Error('정확한 ERP 계정 표시 이름이 필요합니다.');
      const adapters = createProductLowLevelAdapters({identity: (page, scope) => this.identityReader.identity(page, {expectedAccountName}, scope.tenant)});
      const coordinator = new ProductExecutionCoordinator({store:this.store,browser:this.browser,adapters});
      // preflight precedes any ERP browser access; unsupported full is never reduced.
      const ui = await startProductExecutionReviewUI({coordinator,store:this.store,sessionId,input,ttlMs});
      this.ui = ui;
      return {url:ui.url,sessionId,requiresLocalHumanApproval:true,canCommitFullProduct:false};
    } finally { this.preparing = false; }
  }
  async closeReview() {
    if (this.preparing) throw new Error('등록 검토 준비 중입니다. 완료 후 종료하세요.');
    const ui=this.ui;
    if (ui) { await ui.close(); if (this.ui === ui) this.ui=null; }
  }
  async close() { await this.closeReview(); await this.browser.close(); }
}
