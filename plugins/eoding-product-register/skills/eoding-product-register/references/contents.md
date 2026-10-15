# ERP 콘텐츠 등록 형식

관광지·식당·쇼핑·선택관광·미팅장소 콘텐츠는 회사 공용이다. 상품 일정·상세에서 끌어와 연결하므로 한 번 만들면 다른 상품에서도 재사용된다.

## 순서

1. `product_import_source`(seasonMode `excluded`)로 근거 자료(상품 링크, 엑셀, 사용자가 준 목록·텍스트)를 기록한다.
2. **사진은 찾아오지 않는다.** 원문·사용자 자료에 그 콘텐츠의 사진이 있으면 `product_import_images`로 모아 `images`에 넣고, 없으면 `images`를 생략한다. 업체 로고가 박힌 광고 이미지는 넣지 않는다. 사진을 이름에 확신 없이 짝짓지 않는다.
3. `product_import_lookups`로 도시 표시명(예: `아유타야(AUB)`)을 확인한다.
4. `product_content_prepare({id, contents})` → `product_content_review({id})`로 기존 재사용/신규 생성과 사진 유무 요약을 사용자에게 보여준다.
5. 사용자가 같은 범위의 등록을 지시했거나 맡겼으면 추가 승인 질문 없이 `product_content_register({id, companyId, accountName, planDigest, delegation:{explicitUserRequest:true, userInstruction:'직접 사용자의 원문'}})`. 즉시 `status='running'`을 반환하고 백그라운드로 실행한다.
6. `product_import_get({id,compact:true}).contents`의 `stage`, `completedCount`, `count`로 진행을 확인한다. `status='completed'`에서 `results/created/reused/withoutPhotos/durationMs`를 보고한다. 실패·중단 후 같은 호출은 장부와 현재 검색 결과를 먼저 대조한다. 저장 시도한 항목이 재조회되지 않거나 기존 번호가 다르면 자동 재생성을 차단한다. 결과가 불명확한 쓰기는 새 작업으로 우회하지 않는다.

## contents 항목

공통: `type`, `key`(영문 소문자·숫자·하이픈), `name`(한글명), `nameEn?`, `cityLabel`, `description`(필수), `keyword?`, `images?`

| type | 추가 항목 | 비고 |
|---|---|---|
| `place` 관광지 | `address?` | |
| `meal` 식당 | — | |
| `shopping` 쇼핑 | `time`(예: 약 40분), `items`(품목), `refund`(`possible`/`impossible`), `refundTerm?` | 환불 여부는 원문 근거로만 |
| `optionaltour` 선택관광 | `currency`(USD, THB 등), `adultPrice`(숫자), `payment`(현장결제/여행사결제/상품가포함), `guide`(true/false), `duration`(소요시간), `alternative`(미참여 시 대체일정), `address?` | 요금·결제·가이드 동행은 원문 근거로만 |
| `meeting` 미팅장소 | `departport`(인천/서울, 김포, 부산, 대구, 청주, 광주, 제주, 양양, 부산항, 동해항, 인천항, 기타, 무안) | |

```json
[
  { "type": "place", "key": "wat-arun", "name": "왓 아룬", "nameEn": "Wat Arun", "cityLabel": "방콕(BKK)", "description": "차오프라야 강변의 새벽 사원…" },
  { "type": "optionaltour", "key": "night-cruise", "name": "차오프라야 디너 크루즈", "cityLabel": "방콕(BKK)", "description": "…", "currency": "USD", "adultPrice": 60, "payment": "현장결제", "guide": true, "duration": "약 2시간", "alternative": "호텔 휴식 또는 자유시간" }
]
```

## 원칙

- **소개글(description)**: 원문에 없으면 공개 사실(위치·역사·특징)로 짧고 정확하게 쓴다. 과장·순위·확인 안 된 수치를 쓰지 않는다.
- **돈·약속 칸**(선택관광 요금·결제방법·가이드 동행, 쇼핑 환불·시간·품목): 원문에 없으면 지어내지 않는다. 해당 항목을 등록 대상에서 빼고 "확인 필요"로 사용자에게 묻는다.
- 같은 종류·도시·이름의 활성 콘텐츠가 이미 있으면 새로 만들지 않고 재사용한다(기존 내용은 수정하지 않는다). 같은 이름이 여러 개면 ERP에서 정리하도록 알린다.
- 호텔·크루즈(Stay 화면)와 인솔자(개인정보)는 이 기능의 범위가 아니다.
