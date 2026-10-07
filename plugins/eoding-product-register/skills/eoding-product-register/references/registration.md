# AI 내부 입력 계약

이 문서는 AI용이다. 사용자에게 JSON 작성을 요청하지 않는다.

## 상품 원문
product_import_source는 작업 id, sourceDescriptor, sourceDigest와 source.evidence를 반환한다. Excel은 모든 시트·페이지의 셀 근거, URL은 보이는 텍스트·링크·이미지 후보를 수집한다. 이미지 후보는 OCR 결과가 아니다. 로그인·접힌 탭·지연 렌더링과 이미지 속 글자는 별도 확인한다.

product.sources에 반환된 sourceDescriptor를 포함한다. 사용자 답변은 kind=text인 별도 출처로 추가하고 evidence에 연결한다. evidence는 {field, sourceId, location, quote}이며 title, destinations, tripType, includesFlight, currency, nights, days, itinerary 및 포함한 cancellation/departures의 근거를 기록한다.

상품 형식은 도구가 반환하는 fictionalProductExample을 참고하되 예시의 실제 값은 재사용하지 않는다. schemaVersion=1.0. hotels는 일정상의 원문 정보이며 호텔 배정 지시가 아니다. 원문에 없는 취소정책은 시즌 제외 시 cancellation=null, 출발일은 departures=[]로 보존할 수 있다. 모든 일차의 breakfast/lunch/dinner를 명시하며 임의로 0원/불포함/미정으로 채우지 않는다.

## 이미지
product_import_image({id, url 또는 filePath, alt})를 호출한다. 로컬 파일은 capabilities.inputDir 안에 있어야 한다. 반환된 image.id만 등록 매핑에 사용하며 path/hash/identity/approvalBinding을 발명하지 않는다.
PNG/JPEG/WebP, 각 2MB 이하, 상품당 20장. 같은 바이트는 중복 수집하지 않는다. 도구는 원본 바이트를 그대로 보관한다.

## 등록 매핑
product_import_prepare({id, product, registration})에 다음 구조를 전달한다.

registration:
- basic: {options: {cityLabel, managerLabel, priority, cutoffDays}}
  - cityLabel/managerLabel은 ERP 검색결과의 정확한 표시값. priority/cutoffDays는 1~999의 실제 운영값.
- display: {fields: {short_description?, product_description?, badge1?, badge2?, badge3?}, images: [{sourceImageId}], imageQuery, sourceMode?}
  - fields에는 원문에 근거한 표시 문구가 최소 하나 있어야 한다.
  - imageQuery는 이미지 검색용 명시 문자열.
  - 수집한 모든 이미지를 갤러리에 쓸 때는 sourceMode를 생략한다.
  - 일부만 대표/갤러리에 쓸 때 sourceMode=reference-subset. images에는 갤러리 이미지 ID를 순서대로 지정한다. 나머지도 상세 참조 이미지로 보존된다. 긴 상세 이미지를 전시 갤러리에 몰아넣지 않는다.
- content: {detail: {include:[{name,description}], exclude:[{name,description}], information:[문자열], mainPoints:[문자열], shoppingCount:숫자문자열, includeNote?, excludeNote?}, elements:[{type:'3',text:제목},{type:'1',text:본문}]}
  - 쇼핑 횟수도 원문 또는 사용자 결정 근거가 필요하다.
- shell: {title: 일정표 이름}
- season: 시즌 포함 작업에만 지정. 제외 작업에서는 키 자체를 생략한다.

target, companyId, identity, source, itinerary, approvalBinding은 엔진이 생성한다. caller가 전달하지 않는다. 일차 내용은 product.itinerary에서 생성하며 실제 로그인 계정/회사 ID는 전용 브라우저에서 관측한다.

## 시즌 포함 계약
season={fields, selects, selectLabels, selectedDates:[YYYY-MM-DD]}.
현재 공통 실행기는 명시된 출발일 1건의 시즌을 지원한다. 다중 시즌이나 아래 항공 매핑이 없는 경우 지원 범위 확인이 필요하며 임의값으로 통과시키지 않는다.
fields: title, currency_code, adult_base_price, child_base_price, infant_base_price, adult_fuel_price, child_fuel_price, infant_fuel_price, min_pax_count, max_pax_count.
가격/인원은 음이 아닌 정수 문자열, 인원은 1 이상. 각 연령 기본가격+유류할증료가 product.departures의 선택 가격과 일치해야 한다.
왕복 fields: depart-0-depart_date, depart-0-flight_no, depart-0-depart_time, depart-0-arrive_time, arrive-0-depart_date, arrive-0-flight_no, arrive-0-depart_time, arrive-0-arrive_time.
selects는 실제 ERP option value, selectLabels는 대응 표시명: departport, depart-0-airline, depart-0-depart_cd, depart-0-arrive_cd, arrive-0-airline, arrive-0-depart_cd, arrive-0-arrive_cd.
반드시 실제 선택값을 확인한다. 시즌은 행사 생성과 다르다.

## 결과와 중단
source-ready → needs-input/ready-for-review → awaiting-approval → running → completed.
등록 응답만으로 완료가 아니다. finalCheck=verified와 productUrl을 확인한다.
needs-reconciliation/interrupted-needs-reconciliation이면 기존 작업번호와 장부를 보존한다. 자동 재승인·중복 생성·장부 삭제를 하지 않는다. review-preparation-failed는 저장 시작 전 준비 실패이고 원인을 해결한 뒤 새 준비 작업을 만들 수 있지만, 실제 ERP에서 생성된 상품이 있으면 먼저 대사한다.
