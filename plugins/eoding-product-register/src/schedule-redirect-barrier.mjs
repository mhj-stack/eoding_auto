// Chromium response-stage barrier. Browser redirects can bypass Playwright routes.
export async function armScheduleRedirectBarrier(page) {
  const url=new URL(page.url());
  if(url.username || url.password || !(url.origin==='https://schedule-fixture.invalid' || (url.protocol==='http:' && url.hostname==='127.0.0.1'))) {
    throw new Error('Redirect barrier requires reserved fixture or loopback');
  }
  try {
    const session=await page.context().newCDPSession(page);
    session.on('Fetch.requestPaused',async event=>{
      try {
        const redirect=event.responseStatusCode>=300 && event.responseStatusCode<400;
        const safe=['GET','HEAD'].includes(event.request.method);
        if(redirect && !safe) await session.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});
        else await session.send('Fetch.continueRequest',{requestId:event.requestId});
      } catch {
        // If interception breaks, do not release the context unguarded.
        await page.context().close().catch(()=>{});
      }
    });
    await session.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Response'}]});
  } catch {
    await page.context().close().catch(()=>{});
    throw new Error('Redirect barrier installation failed');
  }
}
