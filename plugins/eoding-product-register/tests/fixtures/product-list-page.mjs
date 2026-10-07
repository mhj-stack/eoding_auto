export function listFixture({ href = '/tour/master_product/add/', preopened = false, mutate = false } = {}) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>상품관리</title>
    <button type="button" onclick="openCreation()">상품 생성</button>
    <section id="modal" ${preopened ? '' : 'hidden'}>
      <h1>상품생성</h1>
      <label><input type="radio" name="trip" ${mutate ? 'checked onclick="this.checked=false;document.querySelectorAll(\'[name=trip]\')[1].checked=true"' : ''}>국내상품</label>
      <label><input type="radio" name="trip" ${mutate ? '' : 'checked'}>해외상품</label>
      <label><input type="radio" name="flight">항공포함</label>
      <label><input type="radio" name="flight" checked>항공미포함</label>
      <label><input type="radio" name="vat" checked>부가세 포함</label>
      <label><input type="radio" name="vat">부가세 미포함</label>
      <input class="select-dropdown dropdown-trigger" readonly value="KRW">
      <a id="create" href="${href}" onclick="window.creationClicks++;return true">상품생성</a>
    </section>
    <script>
      window.creationClicks=0;
      function openCreation(){ document.querySelector('#modal').hidden=false; }
    </script></html>`;
}
