export const basicFixture = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>어딩 상품추가</title>
<div><label>통화기준</label><input disabled value="KRW"></div>
<div><label>속성</label><input disabled value="항공미포함"></div>
<div><label>국내/해외</label><input disabled value="국내"></div>
<div><label>판매금액 설정</label><input disabled value="부가세 포함"></div>
<input id="id_2-title"><input id="id_2-sort" value="1"><input id="id_2-master_code"><input id="id_2-master_url"><input id="id_2-reservation_available_date" value="1">
<div><select id="id_2-status" hidden><option value="1">등록중</option><option value="2">비공개</option><option value="3">판매중</option><option value="4">판매중지</option><option value="5">판매종료</option></select><input class="select-dropdown dropdown-trigger" readonly value="등록중" onclick="document.querySelector('#statuses').hidden=false"></div>
<ul id="statuses" hidden><li onclick="document.querySelector('#id_2-status').value='2';document.querySelector('.select-dropdown').value='비공개';this.parentElement.hidden=true">비공개</li></ul>
<select id="id_2-city" hidden><option value=""></option><option value="city-1">제주(CJU)</option></select>
<span id="select2-id_2-city-container" title="도시 선택">도시 선택</span><button type="button" aria-labelledby="select2-id_2-city-container" onclick="openPicker('city')">도시</button>
<select id="id_2-manager" hidden><option value=""></option><option value="manager-1">가상담당자 (테스트팀)</option></select>
<span id="select2-id_2-manager-container" title="담당자 선택">담당자 선택</span><button type="button" aria-labelledby="select2-id_2-manager-container" onclick="openPicker('manager')">담당자</button>
<div id="picker" hidden><input class="select2-search__field" role="textbox" oninput="renderOptions()"><ul role="tree" id="results"></ul></div>
<select id="id_res_cancel_use_flag"><option value="0" selected>온라인 취소 불가</option><option value="1">온라인 취소 가능</option></select>
<select id="id_2-guest_immediate_booking_type"><option value="0" selected>즉시 예약 미사용</option><option value="1">즉시 예약 사용</option></select>
<select id="id_2-departure_confirm_criteria"><option value="0" selected>수동 출발 확정</option><option value="1">자동 출발 확정</option></select>
<input type="password" value="secret-not-to-be-read"><input name="csrf_token" value="token-not-to-be-read">
<a href="#" onclick="window.outsideConfirm=true">확인</a>
<button type="button" onclick="saveProduct()">저장</button>
<div role="dialog" id="success" hidden><div>알림</div><p>상품 생성이 완료되었습니다</p><a href="#" onclick="finish();return false">확인</a></div>
<script>
window.saved=0;window.changes=0;document.addEventListener('input',()=>window.changes++);
const labels={city:'제주(CJU)',manager:'가상담당자 (테스트팀)'};
function openPicker(key){window.pickerKey=key;document.querySelector('#picker').hidden=false;document.querySelector('.select2-search__field').value='';renderOptions()}
function renderOptions(){const root=document.querySelector('#results');root.replaceChildren();const key=window.pickerKey;const label=labels[key];const search=document.querySelector('.select2-search__field').value;if(search!==label.split('(')[0].trim())return;for(let i=0;i<(window.ambiguous===key?2:1);i++){const li=document.createElement('li');li.setAttribute('role','treeitem');li.textContent=label;li.onclick=()=>{const input=document.querySelector('#id_2-'+key);if(input)input.value=key+'-1';const container=document.querySelector('#select2-id_2-'+key+'-container');container.textContent=label;container.title=label;document.querySelector('#picker').hidden=true;if(window.changeSetting)document.querySelector('input[disabled]').value='USD'};root.append(li)}}
function saveProduct(){window.saved++;if(window.noSuccess)return;document.querySelector('#success').hidden=false}
function finish(){document.querySelector('#success').hidden=true;document.title='어딩 상품상세';document.querySelector('#id_2-master_code').value='CJU-SYNTHETIC';document.querySelector('#id_2-master_url').value='https://tenant.eoding-demo.com/master/812345';if(window.mutateAfter)document.querySelector(window.mutateAfter.selector)[window.mutateAfter.property]=window.mutateAfter.value;if(window.navigate)location.href='/tour/master_product/detail/812345/'}
</script></html>`;
